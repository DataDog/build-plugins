// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export interface BackendFunction {
    /** Relative path from project root to the .backend.ts file (without extension) */
    relativePath: string;
    /** Exported function name */
    name: string;
    /** Absolute path to the .backend.ts source file */
    absolutePath: string;
    /** Connection IDs this backend function is allowed to use. */
    allowedConnectionIds: string[];
}

/** Shape of a backend function's result, shared by the remote (dev-server.ts) and in-process (local-execution.ts) execution paths — mirrors the Datadog app-builder query response, which wraps a JS action's return value as `{ data: <value> }`. */
export type BackendOutputs = { data: unknown };
