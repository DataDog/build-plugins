// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */

import type { BackendFunctionTransport } from '../../types';
import { BackendFunctionError } from '../../types';

import type { IframeQueryResponse } from './types';

const POSTMESSAGE_TIMEOUT_MS = 120_000;

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

/**
 * Transport for executing backend functions via `postMessage` when the app
 * is hosted inside an iframe (e.g. App Builder preview). Sends a
 * `app-builder:run-query` message to the parent window and listens for a
 * matching `app-builder:run-query:response` reply. Rejects if no response
 * arrives within {@link POSTMESSAGE_TIMEOUT_MS}.
 */
export const postMessageTransport: BackendFunctionTransport = <TData>(
    functionName: string,
    args: unknown[],
): Promise<TData> => {
    const requestId = generateRequestId();

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

        window.parent.postMessage(
            {
                type: 'app-builder:run-query',
                requestId,
                queryName: functionName,
                args,
            },
            '*',
        );
    });
};
