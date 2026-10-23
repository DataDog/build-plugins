// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { DebugBundleAction, DebugBundleResponse } from '../protocol';

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

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

export function isDebugBundle(data: unknown): data is DebugBundleResponse {
    return (
        isRecord(data) &&
        'code' in data &&
        typeof data.code === 'string' &&
        data.code.length > 0 &&
        'allowedConnectionIds' in data &&
        isStringArray(data.allowedConnectionIds)
    );
}

function isDebugBundleAction(value: unknown): value is DebugBundleAction {
    return (
        isRecord(value) &&
        'fqn' in value &&
        typeof value.fqn === 'string' &&
        'connectionIds' in value &&
        isStringArray(value.connectionIds)
    );
}

// A malformed list is dropped on its own, so the bundle it came with is still sent.
export function copyDebugBundleActions(bundle: object): DebugBundleAction[] | undefined {
    try {
        const actions = 'actions' in bundle ? bundle.actions : undefined;
        if (!Array.isArray(actions)) {
            return undefined;
        }
        const actionsCopy = copyByIndex(actions);
        const copy = actionsCopy.map((action) => {
            if (!isRecord(action)) {
                return undefined;
            }
            const ids = 'connectionIds' in action ? action.connectionIds : undefined;
            return {
                fqn: 'fqn' in action ? action.fqn : undefined,
                connectionIds: Array.isArray(ids) ? copyByIndex(ids) : undefined,
            };
        });
        return copy.every(isDebugBundleAction) ? copy : undefined;
    } catch {
        return undefined;
    }
}
