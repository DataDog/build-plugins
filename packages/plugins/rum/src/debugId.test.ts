// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { initDebugIdHasher, stringToUUID } from '@dd/rum-plugin/debugId';

describe('RUM Plugin - debugId', () => {
    describe('stringToUUID', () => {
        test('Should throw if the hasher is not initialized.', () => {
            expect(() => stringToUUID('some-input')).toThrow(
                '[stringToUUID] Hasher not initialized: call `initDebugIdHasher()` first.',
            );
        });

        test('Should only initialize the underlying hasher once, even when called concurrently.', async () => {
            let freshInitDebugIdHasher!: typeof initDebugIdHasher;
            let xxhashMock!: jest.Mock;

            jest.isolateModules(() => {
                jest.doMock('xxhash-wasm', () => {
                    const actual = jest.requireActual(
                        'xxhash-wasm',
                    ) as typeof import('xxhash-wasm').default;
                    return { __esModule: true, default: jest.fn(actual) };
                });
                ({ initDebugIdHasher: freshInitDebugIdHasher } =
                    require('./debugId') as typeof import('./debugId'));
                ({ default: xxhashMock } = require('xxhash-wasm') as unknown as {
                    default: jest.Mock;
                });
            });

            // Fire overlapping calls before the first one has resolved, then one more after.
            await Promise.all([
                freshInitDebugIdHasher(),
                freshInitDebugIdHasher(),
                freshInitDebugIdHasher(),
            ]);
            await freshInitDebugIdHasher();

            expect(xxhashMock).toHaveBeenCalledTimes(1);
        });

        describe('once initialized', () => {
            beforeAll(async () => {
                await initDebugIdHasher();
            });

            test('Should produce a UUID-v4-shaped identifier.', () => {
                const uuid = stringToUUID('some-input');
                expect(uuid).toMatch(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
                );
            });

            test('Should be deterministic for the same input.', () => {
                expect(stringToUUID('some-input')).toBe(stringToUUID('some-input'));
            });

            test('Should differ for different inputs.', () => {
                expect(stringToUUID('some-input')).not.toBe(stringToUUID('other-input'));
            });
        });
    });
});
