// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * A transport function that executes a backend function via a specific mechanism.
 */
export type BackendFunctionTransport = <TData>(
    functionName: string,
    args: unknown[],
) => Promise<TData>;

/**
 * Error thrown when backend function execution fails
 */
export class BackendFunctionError extends Error {
    constructor(
        message: string,
        public functionName: string,
        public statusCode?: number,
    ) {
        super(message);
        this.name = 'BackendFunctionError';
    }
}
