// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { DebugBundleResponse } from '../protocol';

export function isRecord(data: unknown): data is object {
    return data !== null && typeof data === 'object';
}

// Reads by index into a new array, so none of the source array's own methods (or its `Symbol.species`) run.
export function copyByIndex(list: unknown[]): unknown[] {
    const copy: unknown[] = [];
    for (let index = 0; index < list.length; index++) {
        copy.push(list[index]);
    }
    return copy;
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
