// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { DebugBundleResponse, ExecuteActionResponse } from '../../../protocol';

// Request: iframe → parent.
export type IframeQueryRequest = {
    type: 'app-builder:run-query';
    requestId: string;
    queryName: string;
    args: unknown[];
    bundle?: DebugBundleResponse;
};

// Asks the parent to identify itself: its pong's `event.origin` is set by the browser.
export type IframeQueryPing = {
    type: 'app-builder:ping';
    requestId: string;
};

export type IframeQueryPong = {
    type: 'app-builder:pong';
    requestId: string;
    availableQueries: string[];
};

// Response: parent → iframe, for the `app-builder:run-query` messages the
// transport sends to the parent window.
export type IframeQueryResponse<TData = unknown> = {
    type: 'app-builder:run-query:response';
    requestId: string;
} & ExecuteActionResponse<TData>;
