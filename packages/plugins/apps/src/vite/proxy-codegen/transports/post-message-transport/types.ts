// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { ExecuteActionResponse } from '../../types';

// Request: iframe → parent
export type IframeQueryRequest = {
    type: 'app-builder:run-query';
    requestId: string;
    queryName: string;
    args?: unknown[];
    templateParams?: Record<string, string>;
};

export type IframeQueryPing = {
    type: 'app-builder:ping';
    requestId: string;
};

export type IframeToParentMessage = IframeQueryRequest | IframeQueryPing;

// Response: parent → iframe
export type IframeQueryResponse<TData = unknown> = {
    type: 'app-builder:run-query:response';
    requestId: string;
} & ExecuteActionResponse<TData>;

export type IframeQueryPong = {
    type: 'app-builder:pong';
    requestId: string;
    availableQueries: string[];
};

export type ParentToIframeMessage = IframeQueryResponse | IframeQueryPong;
