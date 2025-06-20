// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis */
const globalAny: any = globalThis;
globalAny.$DD_ALLOW = new Set();

export function $(newValues: string[] | TemplateStringsArray) {
    const initialSize = globalAny.$DD_ALLOW.size;
    newValues.forEach((value) => globalAny.$DD_ALLOW.add(value));
    if (globalAny.$DD_ALLOW.size !== initialSize) {
        if (globalAny.$DD_ALLOW_OBSERVERS) {
            globalAny.$DD_ALLOW_OBSERVERS.forEach((cb: () => void) => cb());
        }
    }

    return newValues;
}
