// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    DebugBundleResponse,
    ExecuteActionResponse,
    RUN_QUERY,
    RUN_QUERY_KEEPALIVE,
    RUN_QUERY_RESPONSE,
} from '../../../protocol';

// Request: iframe → parent.
export type IframeQueryRequest = {
    type: typeof RUN_QUERY;
    requestId: string;
    queryName: string;
    args: unknown[];
    bundle?: DebugBundleResponse;
};

// Response: parent → iframe, for the `app-builder:run-query` messages the
// transport sends to the parent window.
export type IframeQueryResponse<TData = unknown> = {
    type: typeof RUN_QUERY_RESPONSE;
    requestId: string;
} & ExecuteActionResponse<TData>;

// Keepalive: parent → iframe, re-arms a pending request's timeout, e.g. while a consent dialog is open.
export type IframeQueryKeepAlive = {
    type: typeof RUN_QUERY_KEEPALIVE;
    requestId: string;
};
