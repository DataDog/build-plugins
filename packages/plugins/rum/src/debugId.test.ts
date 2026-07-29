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
