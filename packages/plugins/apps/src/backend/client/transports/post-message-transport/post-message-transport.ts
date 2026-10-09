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

import type { IframeQueryRequest, IframeQueryResponse } from './types';

export const POSTMESSAGE_TIMEOUT_MS = 120_000;
export const BUNDLE_FETCH_TIMEOUT_MS = 60_000;

let requestCounter = 0;

function generateRequestId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    requestCounter += 1;
    return `req-${Date.now()}-${requestCounter}`;
}

function isQueryResponse(data: unknown, requestId: string): data is IframeQueryResponse {
    return (
        data !== null &&
        typeof data === 'object' &&
        'type' in data &&
        data.type === 'app-builder:run-query:response' &&
        'requestId' in data &&
        data.requestId === requestId
    );
}

function isDebugBundle(data: unknown): data is DebugBundleResponse {
    return (
        data !== null &&
        typeof data === 'object' &&
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
    return url.protocol === 'https:' && url.port === '' && parseSite(url.hostname) !== undefined;
}

/** The parent's origin when it is a Datadog page and this app runs on its dev server, else `undefined`. */
function getBundleRecipientOrigin(): string | undefined {
    if (Reflect.get(globalThis, DEV_SERVER_MARKER) !== true) {
        return undefined;
    }
    // Absent in Firefox; without it the parent can't be identified, so no bundle is sent.
    const parentOrigin: string | undefined = window.location.ancestorOrigins?.[0];
    if (parentOrigin === undefined || !isDatadogOrigin(parentOrigin)) {
        return undefined;
    }
    return parentOrigin;
}

async function describeErrorResponse(response: Response): Promise<string> {
    const status = `HTTP ${response.status}`;
    try {
        const body: unknown = await response.json();
        if (
            body !== null &&
            typeof body === 'object' &&
            'error' in body &&
            typeof body.error === 'string'
        ) {
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

/** Resolves `undefined` rather than throwing when the dev server returns no usable bundle, so the call is still sent. */
async function fetchOwnBundle(functionName: string): Promise<DebugBundleResponse | undefined> {
    const request: Pick<ExecuteActionRequest, 'functionName'> = { functionName };
    const requestBody = JSON.stringify(request);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BUNDLE_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(DEBUG_BUNDLE_PATH, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: requestBody,
            signal: controller.signal,
        });
        if (!response.ok) {
            const errorDescription = await describeErrorResponse(response);
            warnMissingBundle(functionName, errorDescription);
            return undefined;
        }
        const body: unknown = await response.json();
        if (!isDebugBundle(body)) {
            warnMissingBundle(functionName, 'the dev server response is not a bundle');
            return undefined;
        }
        return { code: body.code, allowedConnectionIds: body.allowedConnectionIds };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        warnMissingBundle(functionName, errorMessage);
        return undefined;
    } finally {
        clearTimeout(timeoutId);
    }
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
    const recipientOrigin = getBundleRecipientOrigin();
    const bundle = recipientOrigin === undefined ? undefined : await fetchOwnBundle(functionName);

    return new Promise<TData>((resolve, reject) => {
        let timeoutId: ReturnType<typeof setTimeout>;

        function cleanup(): void {
            window.removeEventListener('message', handleMessage);
            clearTimeout(timeoutId);
        }

        function handleMessage(event: MessageEvent): void {
            if (!isQueryResponse(event.data, requestId)) {
                return;
            }

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
        // The browser delivers a bundle only to the exact parent origin that passed the Datadog check.
        const targetOrigin = bundle && recipientOrigin ? recipientOrigin : '*';
        try {
            window.parent.postMessage(message, targetOrigin);
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
};
