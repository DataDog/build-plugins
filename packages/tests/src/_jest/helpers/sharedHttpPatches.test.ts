// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    HEADERS_RESTORE_SYMBOL_DESCRIPTION,
    getSharedSlots,
    getSlotsOffBaseline,
    resetSharedHttpPatches,
} from './sharedHttpPatches';

// Node's core modules and the globals Jest's node environment passes through are worker-shared.
const SHARED_MODULE_NAMES = [
    'buffer',
    'child_process',
    'crypto',
    'dns',
    'events',
    'fs',
    'http',
    'http2',
    'https',
    'net',
    'stream',
    'tls',
    'url',
    'util',
    'worker_threads',
    'zlib',
];
const sharedModules = SHARED_MODULE_NAMES.map((name) => {
    const target = jest.requireActual<object>(name);
    return { name, target };
});
const PATCH_TARGETS = [
    ...sharedModules,
    { name: 'Headers', target: Headers },
    { name: 'Headers.prototype', target: Headers.prototype },
    { name: 'Request.prototype', target: Request.prototype },
    { name: 'Response.prototype', target: Response.prototype },
];

// Reads descriptors rather than values: some Headers.prototype getters throw on the prototype itself.
const getOwnValues = (target: object) => {
    const keys = Reflect.ownKeys(target);
    const entries = keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        const value: unknown = descriptor?.value ?? descriptor?.get;
        const entry: [string | symbol, unknown] = [key, value];
        return entry;
    });
    return new Map(entries);
};

const getHeadersSymbolDescriptors = () => {
    const symbols = Object.getOwnPropertySymbols(Headers);
    return symbols.map((symbol) => {
        const descriptor = Object.getOwnPropertyDescriptor(Headers, symbol);
        return { symbol, descriptor };
    });
};

describe('resetSharedHttpPatches', () => {
    let slotValuesBeforeTest: unknown[] = [];
    let headersSymbolsBeforeTest: ReturnType<typeof getHeadersSymbolDescriptors> = [];

    // The resets in these tests also undo this file's own nock, so put its patches back after each.
    beforeEach(() => {
        slotValuesBeforeTest = getSharedSlots().map(({ target, key }) => Reflect.get(target, key));
        headersSymbolsBeforeTest = getHeadersSymbolDescriptors();
    });

    afterEach(() => {
        getSharedSlots().forEach(({ target, key }, index) => {
            Reflect.set(target, key, slotValuesBeforeTest[index]);
        });
        for (const { symbol, descriptor } of headersSymbolsBeforeTest) {
            if (descriptor && !Reflect.has(Headers, symbol)) {
                Object.defineProperty(Headers, symbol, descriptor);
            }
        }
    });

    const cases = getSharedSlots();

    test.each(cases)('Should put back a patched $name', ({ target, key }) => {
        resetSharedHttpPatches();
        const baselineValue: unknown = Reflect.get(target, key);
        Reflect.set(target, key, () => {});

        resetSharedHttpPatches();

        const resetValue: unknown = Reflect.get(target, key);
        expect(resetValue).toBe(baselineValue);
    });

    test('Should drop only the restore functions copies of nock left on Headers', () => {
        resetSharedHttpPatches();
        const symbolsBefore = Object.getOwnPropertySymbols(Headers);
        const leftover = Symbol(HEADERS_RESTORE_SYMBOL_DESCRIPTION);
        const unrelated = Symbol('unrelated');
        Reflect.set(Headers, leftover, () => {});
        Reflect.set(Headers, unrelated, true);

        resetSharedHttpPatches();

        const remainingSymbols = Object.getOwnPropertySymbols(Headers);
        Reflect.deleteProperty(Headers, unrelated);
        expect(remainingSymbols).toEqual([...symbolsBefore, unrelated]);
    });

    test('Should report the slots that differ from the baseline', () => {
        resetSharedHttpPatches();
        const [slot] = getSharedSlots();
        Reflect.set(slot.target, slot.key, () => {});

        const offBaseline = getSlotsOffBaseline();

        expect(offBaseline).toEqual([slot.name]);
    });

    test('Should list every worker-shared property a fresh copy of nock patches', () => {
        resetSharedHttpPatches();
        const valuesBeforeLoad = PATCH_TARGETS.map(({ target }) => getOwnValues(target));
        let loadedNock: typeof import('nock') | undefined;
        jest.isolateModules(() => {
            loadedNock = jest.requireActual<typeof import('nock')>('nock');
        });

        const patchedNames = PATCH_TARGETS.flatMap(({ name, target }, index) => {
            const valuesAfterLoad = getOwnValues(target);
            const changedKeys = [...valuesAfterLoad.keys()].filter(
                (key) => valuesAfterLoad.get(key) !== valuesBeforeLoad[index].get(key),
            );
            return changedKeys.map((key) => `${name}.${String(key)}`);
        });
        loadedNock?.restore();

        const slotNames = getSharedSlots().map(({ name }) => name);
        const restoreSymbolName = `Headers.Symbol(${HEADERS_RESTORE_SYMBOL_DESCRIPTION})`;
        const handledNames = [...slotNames, restoreSymbolName];
        const unhandledNames = patchedNames.filter((name) => !handledNames.includes(name));
        expect(patchedNames.length).toBeGreaterThan(0);
        expect(unhandledNames).toEqual([]);
    });
});
