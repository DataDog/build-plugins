// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { DebugBundleResponse } from '../protocol';

export function isRecord(data: unknown): data is object {
    return data !== null && typeof data === 'object';
}

export function isDebugBundle(data: unknown): data is DebugBundleResponse {
    return (
        isRecord(data) &&
        'code' in data &&
        typeof data.code === 'string' &&
        data.code.length > 0 &&
        'allowedConnectionIds' in data &&
        Array.isArray(data.allowedConnectionIds) &&
        data.allowedConnectionIds.every((id: unknown) => typeof id === 'string')
    );
}
