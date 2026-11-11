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

export interface ConnectionLabelCallSite {
    label: string;
    /** The call's literal `connectionId`, used when the app has no connection environment config. */
    fallbackConnectionId?: string;
}

/** A backend function after its production build, which also extracts its connection labels. */
export interface BuiltBackendFunction extends BackendFunction {
    connectionLabels: ConnectionLabelCallSite[];
}

/** Shape of a backend function's result, shared by the remote (dev-server.ts) and local (local-execution-process.ts) paths — mirrors the app-builder query response's `{ data: <value> }` wrapper. */
export type BackendOutputs = { data: unknown };
