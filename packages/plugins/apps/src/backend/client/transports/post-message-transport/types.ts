// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { ExecuteActionResponse } from '../../../protocol';

// Response: parent → iframe, for the `app-builder:run-query` messages the
// transport sends to the parent window.
export type IframeQueryResponse<TData = unknown> = {
    type: 'app-builder:run-query:response';
    requestId: string;
} & ExecuteActionResponse<TData>;
