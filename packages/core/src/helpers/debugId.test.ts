// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';
import { mockLogger } from '@dd/tests/_jest/helpers/mocks';

import { areDebugIdsEnabled, getChunkDebugId, stringToUUID } from './debugId';

const UUID_V4_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('Debug ID Helpers', () => {
    describe('stringToUUID', () => {
        // Debug IDs key uploaded sourcemaps, so their values must never change.
        const cases = [
            { input: '', expected: 'e3b0c442-98fc-4c14-9afb-f4c8996fb924' },
            { input: 'hello', expected: '2cf24dba-5fb0-430e-a6e8-3b2ac5b9e29e' },
            {
                input: 'console.log("chunk");',
                expected: '56443749-a215-4311-a331-34f5e560ce4e',
            },
            { input: 'a1b2c3d4e5f6', expected: 'bde81e93-84b7-448e-9795-1ec32c734445' },
        ];

        test.each(cases)('should convert "$input" to $expected', ({ input, expected }) => {
            const uuid = stringToUUID(input);

            expect(uuid).toBe(expected);
            expect(uuid).toMatch(UUID_V4_RX);
        });
    });

    describe('getChunkDebugId', () => {
        test('should derive the debug ID from the chunk source or hash only', () => {
            const sourceOrHash = 'console.log("chunk");';
            const entryChunk = { sourceOrHash, fileName: 'main.js', isEntry: true };
            const otherChunk = { sourceOrHash, fileName: 'chunk.js', isEntry: false };

            const expected = stringToUUID(sourceOrHash);

            expect(getChunkDebugId(entryChunk)).toBe(expected);
            expect(getChunkDebugId(otherChunk)).toBe(expected);
        });
    });

    describe('areDebugIdsEnabled', () => {
        const cases: { description: string; options: Options; expected: boolean }[] = [
            {
                description: 'be disabled without RUM configuration',
                options: {},
                expected: false,
            },
            {
                description: 'be disabled without source code context',
                options: { rum: {} },
                expected: false,
            },
            {
                description: 'be disabled with a service-based source code context',
                options: { rum: { sourceCodeContext: { service: 'checkout' } } },
                expected: false,
            },
            {
                description: 'be disabled when debugId is false',
                options: { rum: { sourceCodeContext: { debugId: false, service: 'checkout' } } },
                expected: false,
            },
            {
                description: 'be enabled when debugId is true',
                options: { rum: { sourceCodeContext: { debugId: true } } },
                expected: true,
            },
            {
                description: 'be disabled when the RUM plugin is disabled',
                options: { rum: { enable: false, sourceCodeContext: { debugId: true } } },
                expected: false,
            },
        ];

        test.each(cases)('should $description', ({ options, expected }) => {
            expect(areDebugIdsEnabled(options, mockLogger)).toBe(expected);
        });
    });
});
