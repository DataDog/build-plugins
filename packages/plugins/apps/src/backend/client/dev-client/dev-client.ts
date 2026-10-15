// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */

import { parseSite } from '@dd/core/helpers/site';

import { DEBUG_BUNDLE_PATH, PING, PONG, RUN_QUERY_RESPONSE } from '../../protocol';
import type {
    DebugBundleResponse,
    ExecuteActionRequest,
    IframeQueryPing,
    PrepareCall,
} from '../../protocol';
import { isDebugBundle, isRecord } from '../guards';
import { generateRequestId } from '../request-id';

export const BUNDLE_FETCH_TIMEOUT_MS = 60_000;
export const PARENT_PING_TIMEOUT_MS = 2_000;

// The bridge requires a ping's requestId, but any answer from the parent will do: the frame only needs its origin.
function isParentAnswer(data: unknown): boolean {
    return (
        isRecord(data) && 'type' in data && (data.type === PONG || data.type === RUN_QUERY_RESPONSE)
    );
}

function isDatadogOrigin(origin: string): boolean {
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        return false;
    }
    // A fully qualified hostname keeps its trailing root dot, which parseSite doesn't expect.
    const hostname = url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname;
    return url.protocol === 'https:' && url.port === '' && parseSite(hostname) !== undefined;
}

export const MAX_UNANSWERED_PINGS = 2;

let learnedParentOrigin: string | undefined;
let unansweredPings = 0;
let pendingPing: { answered: Promise<void>; end: () => void } | undefined;
let warnedUnansweredPing = false;

/** @internal Exposed only for tests to reset what the frame learned about its parent between cases. */
export const resetDevClient = (): void => {
    pendingPing?.end();
    if (typeof window !== 'undefined') {
        window.removeEventListener('message', handleParentMessage);
    }
    learnedParentOrigin = undefined;
    unansweredPings = 0;
    warnedUnansweredPing = false;
};

// The browser stamps the sender's origin on each message, so a pong or response from the parent reveals it.
function handleParentMessage(event: MessageEvent): void {
    if (event.source !== window.parent || !isParentAnswer(event.data)) {
        return;
    }
    learnedParentOrigin = event.origin;
    window.removeEventListener('message', handleParentMessage);
    pendingPing?.end();
}

/** Shares one ping between calls; after a timeout, its listener stays for a late answer. */
function pingParent(): Promise<void> {
    if (pendingPing !== undefined) {
        return pendingPing.answered;
    }
    window.addEventListener('message', handleParentMessage);
    let resolveAnswered = (): void => {};
    const answered = new Promise<void>((resolve) => {
        resolveAnswered = resolve;
    });
    const timeoutId = setTimeout(miss, PARENT_PING_TIMEOUT_MS);

    function end(): void {
        clearTimeout(timeoutId);
        pendingPing = undefined;
        resolveAnswered();
    }

    function miss(): void {
        unansweredPings += 1;
        end();
    }

    pendingPing = { answered, end };
    const ping: IframeQueryPing = { type: PING, requestId: generateRequestId() };
    try {
        window.parent.postMessage(ping, '*');
    } catch {
        miss();
    }
    return answered;
}

// Firefox has no ancestorOrigins; App Builder's bridge answers a ping from its frame.
// After MAX_UNANSWERED_PINGS misses, calls stop pinging; a later pong or response still sets the origin.
function needsParentPing(): boolean {
    return (
        !window.location.ancestorOrigins &&
        window.parent !== window &&
        learnedParentOrigin === undefined &&
        unansweredPings < MAX_UNANSWERED_PINGS
    );
}

async function getParentOrigin(shouldPing: boolean): Promise<string | undefined> {
    const ancestorOrigins = window.location.ancestorOrigins;
    if (ancestorOrigins) {
        return ancestorOrigins[0];
    }
    if (shouldPing) {
        await pingParent();
    }
    return learnedParentOrigin;
}

async function describeErrorResponse(response: Response): Promise<string> {
    const status = `HTTP ${response.status}`;
    try {
        const body: unknown = await response.json();
        if (isRecord(body) && 'error' in body && typeof body.error === 'string') {
            return `${status}: ${body.error}`;
        }
        return status;
    } catch {
        return status;
    }
}

function warnMissingBundle(functionName: string, reason: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[dd-apps] Sending "${functionName}" without its dev server bundle: ${reason}`);
}

function warnUnansweredPingOnce(functionName: string): void {
    if (warnedUnansweredPing) {
        return;
    }
    warnedUnansweredPing = true;
    warnMissingBundle(
        functionName,
        "no answer came back from the parent page, so it can't be confirmed as a Datadog page",
    );
}

type BundleFetch = { bundle: DebugBundleResponse } | { failure: string };

/** Never rejects: a call without a usable bundle is still sent, so a failure is returned for the caller to report. */
async function fetchOwnBundle(functionName: string): Promise<BundleFetch> {
    const request: Pick<ExecuteActionRequest, 'functionName'> = { functionName };
    const requestBody = JSON.stringify(request);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        const timeoutError = new Error(`timed out after ${BUNDLE_FETCH_TIMEOUT_MS}ms`);
        controller.abort(timeoutError);
    }, BUNDLE_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(DEBUG_BUNDLE_PATH, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: requestBody,
            signal: controller.signal,
        });
        if (!response.ok) {
            const errorDescription = await describeErrorResponse(response);
            return { failure: errorDescription };
        }
        const body: unknown = await response.json();
        if (!isDebugBundle(body)) {
            return { failure: 'the dev server response is not a bundle' };
        }
        return { bundle: { code: body.code, allowedConnectionIds: body.allowedConnectionIds } };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { failure: errorMessage };
    } finally {
        clearTimeout(timeoutId);
    }
}

/** The function's bundle and the exact origin to post it to, when this dev page is framed by a Datadog page. */
export const prepareCall: PrepareCall = async (functionName) => {
    const isPinging = needsParentPing();
    // The build runs while the parent answers its ping, and is dropped unless a Datadog parent answers.
    const earlyFetch = isPinging ? fetchOwnBundle(functionName) : undefined;
    const recipientOrigin = await getParentOrigin(isPinging);
    if (recipientOrigin === undefined && isPinging) {
        warnUnansweredPingOnce(functionName);
    }
    if (recipientOrigin === undefined || !isDatadogOrigin(recipientOrigin)) {
        return {};
    }
    const result = await (earlyFetch ?? fetchOwnBundle(functionName));
    if ('failure' in result) {
        warnMissingBundle(functionName, result.failure);
        return { targetOrigin: recipientOrigin };
    }
    return { targetOrigin: recipientOrigin, bundle: result.bundle };
};
