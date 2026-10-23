// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { DebugBundleAction, DebugBundleActionCall, DebugBundleResponse } from '../protocol';

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

function isStringRecord(value: unknown): value is Record<string, string> {
    return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isDebugBundleActionCall(value: unknown): value is DebugBundleActionCall {
    return (
        isRecord(value) &&
        (!('connectionId' in value) || typeof value.connectionId === 'string') &&
        'inputs' in value &&
        isStringRecord(value.inputs)
    );
}

function isDebugBundleAction(value: unknown): value is DebugBundleAction {
    return (
        isRecord(value) &&
        'fqn' in value &&
        typeof value.fqn === 'string' &&
        'connectionIds' in value &&
        isStringArray(value.connectionIds) &&
        'calls' in value &&
        Array.isArray(value.calls) &&
        value.calls.every(isDebugBundleActionCall)
    );
}

// Copies own enumerable entries into a plain object, so no inherited key or accessor survives.
function copyOwnEntries(record: object): Record<string, unknown> {
    const entries = Object.keys(record).map((key) => [key, Reflect.get(record, key)]);
    return Object.fromEntries(entries);
}

function getOwn(record: object, key: string): unknown {
    return Object.prototype.hasOwnProperty.call(record, key) ? Reflect.get(record, key) : undefined;
}

function copyCall(call: unknown): object | undefined {
    if (!isRecord(call)) {
        return undefined;
    }
    const inputs = getOwn(call, 'inputs');
    const hasOwnConnectionId = Object.prototype.hasOwnProperty.call(call, 'connectionId');
    return {
        ...(hasOwnConnectionId && { connectionId: Reflect.get(call, 'connectionId') }),
        inputs: isRecord(inputs) && !Array.isArray(inputs) ? copyOwnEntries(inputs) : undefined,
    };
}

// A malformed list is dropped on its own, so the bundle it came with is still sent.
export function copyDebugBundleActions(bundle: object): DebugBundleAction[] | undefined {
    try {
        const actions = getOwn(bundle, 'actions');
        if (!Array.isArray(actions)) {
            return undefined;
        }
        const actionsCopy = copyByIndex(actions);
        const copy = actionsCopy.map((action) => {
            if (!isRecord(action)) {
                return undefined;
            }
            const ids = getOwn(action, 'connectionIds');
            const calls = getOwn(action, 'calls');
            return {
                fqn: getOwn(action, 'fqn'),
                connectionIds: Array.isArray(ids) ? copyByIndex(ids) : undefined,
                calls: Array.isArray(calls) ? copyByIndex(calls).map(copyCall) : undefined,
            };
        });
        return copy.every(isDebugBundleAction) ? copy : undefined;
    } catch {
        return undefined;
    }
}
