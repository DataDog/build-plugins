// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import https from 'https';
import http from 'http';

type SharedSlot = { name: string; target: object; key: string };

// The worker-shared properties a copy of nock and its @mswjs/interceptors patch when it loads.
export const getSharedSlots = (): SharedSlot[] => [
    { name: 'http.request', target: http, key: 'request' },
    { name: 'http.get', target: http, key: 'get' },
    { name: 'http.ClientRequest', target: http, key: 'ClientRequest' },
    { name: 'https.request', target: https, key: 'request' },
    { name: 'https.get', target: https, key: 'get' },
    { name: 'Headers.prototype.set', target: Headers.prototype, key: 'set' },
    { name: 'Headers.prototype.append', target: Headers.prototype, key: 'append' },
    { name: 'Headers.prototype.delete', target: Headers.prototype, key: 'delete' },
];

// Each baseline value is stored on its own key of the http module, so no object created in a test
// file's realm outlives that file.
const getBaselineKey = (name: string) => Symbol.for(`@dd/tests/sharedHttpBaseline/${name}`);

// @mswjs/interceptors leaves its Headers restore function under a symbol of this name. Once
// setupAfterEnv restored the nock it can reach, any one still there belongs to a lost copy.
export const HEADERS_RESTORE_SYMBOL_DESCRIPTION = 'kRestorePatches';

const hasBaseline = () => {
    const [firstSlot] = getSharedSlots();
    const firstBaselineKey = getBaselineKey(firstSlot.name);
    return Reflect.has(http, firstBaselineKey);
};

const recordBaseline = () => {
    // nock names its http.ClientRequest override this way, so a baseline taken after nock loaded
    // would bring that copy's patches back on every reset.
    if (http.ClientRequest.name === 'OverriddenClientRequest') {
        throw new Error('nock was loaded before setupAfterEnv.ts could record the http baseline.');
    }
    for (const { name, target, key } of getSharedSlots()) {
        const baselineKey = getBaselineKey(name);
        const value: unknown = Reflect.get(target, key);
        Reflect.set(http, baselineKey, value);
    }
};

const restoreBaseline = () => {
    for (const { name, target, key } of getSharedSlots()) {
        const baselineKey = getBaselineKey(name);
        const baselineValue: unknown = Reflect.get(http, baselineKey);
        if (!Reflect.set(target, key, baselineValue)) {
            throw new Error(`Couldn't put back ${name}, which is no longer writable.`);
        }
    }
};

// Every call drops the restore functions copies of nock left on Headers. The first call in a
// worker also records the slots, and every later call puts them back.
export const resetSharedHttpPatches = () => {
    if (hasBaseline()) {
        restoreBaseline();
    } else {
        recordBaseline();
    }
    const leftoverSymbols = Object.getOwnPropertySymbols(Headers).filter(
        (symbol) => symbol.description === HEADERS_RESTORE_SYMBOL_DESCRIPTION,
    );
    for (const symbol of leftoverSymbols) {
        Reflect.deleteProperty(Headers, symbol);
    }
};

export const getSlotsOffBaseline = () => {
    if (!hasBaseline()) {
        throw new Error('No shared http baseline was recorded in this worker.');
    }
    const slots = getSharedSlots();
    const offBaseline = slots.filter(({ name, target, key }) => {
        const baselineKey = getBaselineKey(name);
        const baselineValue: unknown = Reflect.get(http, baselineKey);
        const value: unknown = Reflect.get(target, key);
        return value !== baselineValue;
    });
    return offBaseline.map(({ name }) => name);
};
