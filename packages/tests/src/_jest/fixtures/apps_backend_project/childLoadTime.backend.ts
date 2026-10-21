// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

declare const $: { Actions: { http: { request(call: unknown): Promise<unknown> } } } | undefined;

const dollarAtLoad = $ === undefined ? 'undefined' : 'set';

let earlyAction: Promise<unknown> | undefined;
// Fires while the dev server is still registering the SDK adapters, before the call starts.
setTimeout(() => {
    earlyAction = $?.Actions.http.request({ inputs: { early: true } });
}, 0);

export async function readDollarAtLoad() {
    return { dollarAtLoad, dollarAtCall: typeof $ };
}

export async function awaitEarlyAction() {
    return earlyAction;
}
