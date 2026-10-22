// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis */

import {
    DEV_CLIENT_HOOK,
    RUN_QUERY,
    RUN_QUERY_KEEPALIVE,
    RUN_QUERY_RESPONSE,
} from '../../../protocol';
import type { DebugBundleResponse, PreparedCall } from '../../../protocol';
import { copyByIndex, copyDebugBundleActions, isDebugBundle, isRecord } from '../../guards';
import { generateRequestId } from '../../request-id';
import type { BackendFunctionTransport } from '../../types';
import { BackendFunctionError } from '../../types';

import type { IframeQueryKeepAlive, IframeQueryRequest, IframeQueryResponse } from './types';

export const POSTMESSAGE_TIMEOUT_MS = 120_000;
// A safety net for a parent that keeps a call alive but never answers, not a user deadline.
export const POSTMESSAGE_MAX_WAIT_MS = 60 * 60_000;

function isMessageFor(data: unknown, type: string, requestId: string): boolean {
    return (
        isRecord(data) &&
        'type' in data &&
        data.type === type &&
        'requestId' in data &&
        data.requestId === requestId
    );
}

function isKeepAlive(data: unknown, requestId: string): data is IframeQueryKeepAlive {
    return isMessageFor(data, RUN_QUERY_KEEPALIVE, requestId);
}

function isQueryResponse<TData>(
    data: unknown,
    requestId: string,
): data is IframeQueryResponse<TData> {
    return isMessageFor(data, RUN_QUERY_RESPONSE, requestId);
}

// Only an exact target origin restricts who receives the message, so a bundle is never posted with '*'.
function isExactOrigin(targetOrigin: unknown): targetOrigin is string {
    if (typeof targetOrigin !== 'string') {
        return false;
    }
    try {
        return new URL(targetOrigin).origin === targetOrigin;
    } catch {
        return false;
    }
}

function copyBundle(candidate: unknown): DebugBundleResponse | undefined {
    if (!isRecord(candidate)) {
        return undefined;
    }
    const ids = 'allowedConnectionIds' in candidate ? candidate.allowedConnectionIds : undefined;
    // Checked on a copy, so only the code, connection ids and action list reach postMessage.
    const copy = {
        code: 'code' in candidate ? candidate.code : undefined,
        allowedConnectionIds: Array.isArray(ids) ? copyByIndex(ids) : undefined,
    };
    if (!isDebugBundle(copy)) {
        return undefined;
    }
    const actions = copyDebugBundleActions(candidate);
    return { ...copy, ...(actions && { actions }) };
}

// Any page script could install the hook, so its result is checked before anything is posted.
function toPreparedCall(value: unknown): PreparedCall {
    try {
        if (!isRecord(value)) {
            return {};
        }
        const targetOrigin = 'targetOrigin' in value ? value.targetOrigin : undefined;
        if (!isExactOrigin(targetOrigin)) {
            return {};
        }
        const bundle = copyBundle('bundle' in value ? value.bundle : undefined);
        return bundle === undefined ? { targetOrigin } : { targetOrigin, bundle };
    } catch {
        return {};
    }
}

function readDevClientHook(): unknown {
    try {
        return Reflect.get(globalThis, DEV_CLIENT_HOOK);
    } catch {
        return undefined;
    }
}

function isPrepareCall(value: unknown): value is (functionName: string) => unknown {
    return typeof value === 'function';
}

function postRunQuery<TData>(
    functionName: string,
    args: unknown[],
    { targetOrigin, bundle }: PreparedCall,
): Promise<TData> {
    const requestId = generateRequestId();

    return new Promise<TData>((resolve, reject) => {
        // Wall-clock deadlines, so time the machine spends asleep counts toward them.
        const maxDeadline = Date.now() + POSTMESSAGE_MAX_WAIT_MS;
        let deadline = Date.now() + POSTMESSAGE_TIMEOUT_MS;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        function cleanup(): void {
            window.removeEventListener('message', handleMessage);
            clearTimeout(timeoutId);
        }

        function timeOut(): void {
            cleanup();
            const timeoutError = new BackendFunctionError(
                `Backend function "${functionName}" timed out waiting for response`,
                functionName,
            );
            reject(timeoutError);
        }

        function checkDeadline(): void {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                timeOut();
                return;
            }
            timeoutId = setTimeout(checkDeadline, remainingMs);
        }

        function isFromRecipient(event: MessageEvent<unknown>): boolean {
            return (
                event.source === window.parent &&
                (targetOrigin === undefined || event.origin === targetOrigin)
            );
        }

        function handleMessage(event: MessageEvent<unknown>): void {
            if (!isFromRecipient(event)) {
                return;
            }
            const response = event.data;
            if (isKeepAlive(response, requestId)) {
                if (Date.now() >= deadline) {
                    timeOut();
                    return;
                }
                deadline = Math.min(Date.now() + POSTMESSAGE_TIMEOUT_MS, maxDeadline);
                return;
            }
            if (!isQueryResponse<TData>(response, requestId)) {
                return;
            }

            cleanup();

            // The parent's reply is checked here, so a malformed one settles the call instead of throwing.
            if (response.success === true && isRecord(response.result)) {
                resolve(response.result.data);
                return;
            }
            const parentError = 'error' in response ? response.error : undefined;
            const errorMessage =
                typeof parentError === 'string'
                    ? parentError
                    : `Backend function "${functionName}" failed`;
            const failure = new BackendFunctionError(errorMessage, functionName);
            reject(failure);
        }

        window.addEventListener('message', handleMessage);
        checkDeadline();

        const message: IframeQueryRequest = {
            type: RUN_QUERY,
            requestId,
            queryName: functionName,
            args,
            ...(bundle && { bundle }),
        };
        try {
            window.parent.postMessage(message, targetOrigin ?? '*');
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}

/**
 * Transport for backend functions in a frame (e.g. App Builder preview): posts
 * `app-builder:run-query` to the parent and waits {@link POSTMESSAGE_TIMEOUT_MS} for the response,
 * re-armed by each keepalive up to {@link POSTMESSAGE_MAX_WAIT_MS}. On a Datadog-framed dev server,
 * the injected dev client first adds the function's bundle and the parent's exact origin, which can
 * take up to another {@link POSTMESSAGE_TIMEOUT_MS} before the call is sent without them.
 */
export const postMessageTransport: BackendFunctionTransport = <TData>(
    functionName: string,
    args: unknown[],
): Promise<TData> => {
    const prepareCall = readDevClientHook();
    if (!isPrepareCall(prepareCall)) {
        return postRunQuery<TData>(functionName, args, {});
    }
    // A failing or stuck hook must not stop the call, which is then sent as it would be outside dev.
    let giveUpTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const givenUp = new Promise<unknown>((resolve) => {
        giveUpTimeoutId = setTimeout(() => resolve({}), POSTMESSAGE_TIMEOUT_MS);
    });
    const prepared = Promise.resolve()
        .then(() => prepareCall(functionName))
        .catch(() => ({}));
    return Promise.race([prepared, givenUp]).then((preparedCall) => {
        clearTimeout(giveUpTimeoutId);
        const checkedCall = toPreparedCall(preparedCall);
        return postRunQuery<TData>(functionName, args, checkedCall);
    });
};
