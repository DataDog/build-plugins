// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis */
(globalThis as any).$DD_ALLOW = new Set();
// eslint-disable-next-line no-unused-expressions
(globalThis as any).$DD_ALLOW_OBSERVERS;

export function $(newValues: string[] | TemplateStringsArray) {
    const initialSize = (globalThis as any).$DD_ALLOW.size;
    newValues.forEach((value) => (globalThis as any).$DD_ALLOW.add(value));
    const newSize = (globalThis as any).$DD_ALLOW.size;
    if (newSize !== initialSize) {
        if ((globalThis as any).$DD_ALLOW_OBSERVERS) {
            (globalThis as any).$DD_ALLOW_OBSERVERS.forEach((cb: (newSize?: number) => void) =>
                cb(newSize),
            );
        }
    }

    return newValues;
}
