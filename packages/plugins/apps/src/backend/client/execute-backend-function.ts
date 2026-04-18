// eslint-disable-next-line spaced-comment
/// <reference lib="dom" />

// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */

import { devServerTransport } from './transports/dev-server-transport';
import { postMessageTransport } from './transports/post-message-transport/post-message-transport';
import type { BackendFunctionTransport } from './types';

function isInIframe(): boolean {
    try {
        return typeof window !== 'undefined' && window.parent !== window;
    } catch {
        // Accessing window.parent can throw if cross-origin
        return true;
    }
}

function resolveTransport(): BackendFunctionTransport {
    if (isInIframe()) {
        return postMessageTransport;
    }
    return devServerTransport;
}

/**
 * Executes a backend function by name with the provided arguments.
 *
 * When running inside an iframe embedded in App Builder, automatically
 * uses postMessage to communicate with the parent window. Otherwise,
 * uses HTTP fetch to the backend endpoint.
 *
 * @param functionName - The name of the backend function to execute
 * @param args - Array of arguments to pass to the function
 * @returns Promise that resolves to the function's return value
 * @throws {BackendFunctionError} If the request fails or the function throws an error
 *
 * @example
 * ```typescript
 * const result = await executeBackendFunction<{ sum: number }, [number, number]>(
 *   'testWithImport',
 *   [5, 7]
 * );
 * console.log(result.sum); // 12
 * ```
 */
export async function executeBackendFunction<TData = unknown, TArgs extends unknown[] = unknown[]>(
    functionName: string,
    args: TArgs,
): Promise<TData> {
    const transport = resolveTransport();
    return transport<TData>(functionName, args);
}
