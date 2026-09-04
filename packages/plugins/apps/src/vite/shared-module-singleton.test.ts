// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getOrCreateShared } from '@dd/apps-plugin/vite/shared-module-singleton';

describe('shared-module-singleton — getOrCreateShared', () => {
    test("Should return the factory's created value on first call", () => {
        const hostModule = {};
        const value = getOrCreateShared(hostModule, 'my-key', () => ({ count: 1 }));
        expect(value).toEqual({ count: 1 });
    });

    test('Should return the same instance on a second call with the same hostModule and key, not the second factory result', () => {
        const hostModule = {};
        const first = getOrCreateShared(hostModule, 'my-key', () => ({ id: 'first' }));
        const second = getOrCreateShared(hostModule, 'my-key', () => ({ id: 'second' }));

        expect(second).toBe(first);
        expect(second).toEqual({ id: 'first' });
    });

    test('Should call the factory only once across multiple calls, simulating a guard file being evaluated more than once', () => {
        const hostModule = {};
        let factoryCallCount = 0;
        const factory = () => {
            factoryCallCount += 1;
            return { factoryCallCount };
        };

        getOrCreateShared(hostModule, 'my-key', factory);
        getOrCreateShared(hostModule, 'my-key', factory);
        getOrCreateShared(hostModule, 'my-key', factory);

        expect(factoryCallCount).toBe(1);
    });

    test('Should return different instances for different keys on the same hostModule', () => {
        const hostModule = {};
        const a = getOrCreateShared(hostModule, 'key-a', () => ({ which: 'a' }));
        const b = getOrCreateShared(hostModule, 'key-b', () => ({ which: 'b' }));

        expect(a).not.toBe(b);
        expect(a).toEqual({ which: 'a' });
        expect(b).toEqual({ which: 'b' });
    });

    test('Should return different instances for the same key on different hostModule objects', () => {
        const hostModuleA = {};
        const hostModuleB = {};
        const a = getOrCreateShared(hostModuleA, 'shared-key', () => ({ owner: 'A' }));
        const b = getOrCreateShared(hostModuleB, 'shared-key', () => ({ owner: 'B' }));

        expect(a).not.toBe(b);
        expect(a).toEqual({ owner: 'A' });
        expect(b).toEqual({ owner: 'B' });
    });

    test('Should recognize a falsy stored value as already installed, not call the factory again', () => {
        const hostModule = {};
        let factoryCallCount = 0;
        const factory = () => {
            factoryCallCount += 1;
            return false;
        };

        const first = getOrCreateShared(hostModule, 'my-key', factory);
        const second = getOrCreateShared(hostModule, 'my-key', factory);

        expect(first).toBe(false);
        expect(second).toBe(false);
        expect(factoryCallCount).toBe(1);
    });

    test('Should store the value as non-configurable and non-writable, so no caller can swap or delete it', () => {
        const hostModule = {};
        getOrCreateShared(hostModule, 'my-key', () => ({ id: 'original' }));

        const symbol = Object.getOwnPropertySymbols(hostModule)[0];
        const descriptor = Object.getOwnPropertyDescriptor(hostModule, symbol);

        expect(descriptor?.configurable).toBe(false);
        expect(descriptor?.writable).toBe(false);
        expect(descriptor?.enumerable).toBe(false);
    });
});
