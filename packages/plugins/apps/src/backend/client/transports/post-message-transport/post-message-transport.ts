// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis */

import { parseSite } from '@dd/core/helpers/site';

import { DEBUG_BUNDLE_PATH, DEV_SERVER_MARKER } from '../../../protocol';
import type { DebugBundleResponse, ExecuteActionRequest } from '../../../protocol';
import type { BackendFunctionTransport } from '../../types';
import { BackendFunctionError } from '../../types';

import type {
    IframeQueryPing,
    IframeQueryPong,
    IframeQueryRequest,
    IframeQueryResponse,
} from './types';

export const POSTMESSAGE_TIMEOUT_MS = 120_000;
export const BUNDLE_FETCH_TIMEOUT_MS = 60_000;
export const PARENT_PING_TIMEOUT_MS = 2_000;

let requestCounter = 0;

function generateRequestId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    requestCounter += 1;
    return `req-${Date.now()}-${requestCounter}`;
}

function isRecord(data: unknown): data is object {
    return data !== null && typeof data === 'object';
}

function isQueryResponse(data: unknown, requestId: string): data is IframeQueryResponse {
    return (
        isRecord(data) &&
        'type' in data &&
        data.type === 'app-builder:run-query:response' &&
        'requestId' in data &&
        data.requestId === requestId
    );
}

// The bridge requires a ping's requestId, but any pong will do: the frame only needs its origin.
function isPong(data: unknown): data is IframeQueryPong {
    return isRecord(data) && 'type' in data && data.type === 'app-builder:pong';
}

function isDebugBundle(data: unknown): data is DebugBundleResponse {
    return (
        isRecord(data) &&
        'code' in data &&
        typeof data.code === 'string' &&
        data.code.length > 0 &&
        'allowedConnectionIds' in data &&
        Array.isArray(data.allowedConnectionIds) &&
        data.allowedConnectionIds.every((id: unknown) => typeof id === 'string')
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

/** @internal Exposed only for tests to reset what the frame learned about its parent between cases. */
export const resetParentOrigin = (): void => {
    pendingPing?.end();
    if (typeof window !== 'undefined') {
        window.removeEventListener('message', handlePong);
    }
    learnedParentOrigin = undefined;
    unansweredPings = 0;
};

// The browser stamps the sender's origin on each message, so a pong or response from the parent reveals it.
function learnParentOrigin(event: MessageEvent): void {
    learnedParentOrigin = event.origin;
    window.removeEventListener('message', handlePong);
    pendingPing?.end();
}

function handlePong(event: MessageEvent): void {
    if (event.source === window.parent && isPong(event.data)) {
        learnParentOrigin(event);
    }
}

/** Shares one ping between calls; resolves on an answer or a timeout, while the pong listener stays. */
function pingParent(): Promise<void> {
    if (pendingPing !== undefined) {
        return pendingPing.answered;
    }
    window.addEventListener('message', handlePong);
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
    const ping: IframeQueryPing = { type: 'app-builder:ping', requestId: generateRequestId() };
    try {
        window.parent.postMessage(ping, '*');
    } catch {
        miss();
    }
    return answered;
}

// Firefox has no ancestorOrigins; App Builder's bridge answers a ping from its frame.
// After MAX_UNANSWERED_PINGS misses, calls stop pinging until a pong or response from the parent arrives.
function needsParentPing(): boolean {
    return (
        window.location.ancestorOrigins === undefined &&
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
async function prepareBundle(
    functionName: string,
): Promise<{ recipientOrigin?: string; bundle?: DebugBundleResponse }> {
    if (Reflect.get(globalThis, DEV_SERVER_MARKER) !== true) {
        return {};
    }
    const isPinging = needsParentPing();
    // The build runs while the parent answers its ping, and is dropped if the parent is not a Datadog page.
    const earlyFetch = isPinging ? fetchOwnBundle(functionName) : undefined;
    const recipientOrigin = await getParentOrigin(isPinging);
    if (recipientOrigin === undefined || !isDatadogOrigin(recipientOrigin)) {
        return {};
    }
    const result = await (earlyFetch ?? fetchOwnBundle(functionName));
    if ('failure' in result) {
        warnMissingBundle(functionName, result.failure);
        return { recipientOrigin };
    }
    return { recipientOrigin, bundle: result.bundle };
}

/**
 * Transport for executing backend functions via `postMessage` when the app
 * is hosted inside an iframe (e.g. App Builder preview). Sends a
 * `app-builder:run-query` message to the parent window and listens for a
 * matching `app-builder:run-query:response` reply. Rejects if no response
 * arrives within {@link POSTMESSAGE_TIMEOUT_MS} of being sent. On a dev server
 * framed by a Datadog page, the message also carries the function's bundle.
 */
export const postMessageTransport: BackendFunctionTransport = async <TData>(
    functionName: string,
    args: unknown[],
): Promise<TData> => {
    const requestId = generateRequestId();
    const { recipientOrigin, bundle } = await prepareBundle(functionName);

    return new Promise<TData>((resolve, reject) => {
        let timeoutId: ReturnType<typeof setTimeout>;

        function cleanup(): void {
            window.removeEventListener('message', handleMessage);
            clearTimeout(timeoutId);
        }

        function handleMessage(event: MessageEvent): void {
            if (event.source !== window.parent || !isQueryResponse(event.data, requestId)) {
                return;
            }
            learnParentOrigin(event);

            cleanup();

            const response = event.data as IframeQueryResponse<TData>;

            if (response.success) {
                resolve(response.result.data);
            } else {
                reject(
                    new BackendFunctionError(
                        response.error ?? `Backend function "${functionName}" failed`,
                        functionName,
                    ),
                );
            }
        }

        window.addEventListener('message', handleMessage);

        timeoutId = setTimeout(() => {
            cleanup();
            reject(
                new BackendFunctionError(
                    `Backend function "${functionName}" timed out waiting for response`,
                    functionName,
                ),
            );
        }, POSTMESSAGE_TIMEOUT_MS);

        const message: IframeQueryRequest = {
            type: 'app-builder:run-query',
            requestId,
            queryName: functionName,
            args,
            ...(bundle && { bundle }),
        };
        // Once the parent has passed the Datadog check, the browser delivers only to that exact origin.
        const targetOrigin = recipientOrigin ?? '*';
        try {
            window.parent.postMessage(message, targetOrigin);
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
};
