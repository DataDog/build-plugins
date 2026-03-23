// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { BACKEND_VIRTUAL_PREFIX, getBackendPlugin } from '@dd/apps-plugin/backend/index';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';

const log = getMockLogger();

const functions = [
    { name: 'myHandler', entryPath: '/src/backend/myHandler.ts' },
    { name: 'otherFunc', entryPath: '/src/backend/otherFunc/index.ts' },
];

describe('Backend Functions - getBackendPlugin', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
    });

    describe('plugin shape', () => {
        test('Should return a plugin with correct name and enforce', () => {
            const plugin = getBackendPlugin(functions, new Map(), log);
            expect(plugin.name).toBe('datadog-apps-backend-plugin');
            expect(plugin.enforce).toBe('pre');
        });

        test('Should have rollup and vite properties', () => {
            const plugin = getBackendPlugin(functions, new Map(), log);
            expect(plugin.rollup).toBeDefined();
            expect(plugin.vite).toBeDefined();
        });
    });

    describe('resolveId', () => {
        const cases = [
            {
                description: 'resolve virtual backend module ID',
                input: `${BACKEND_VIRTUAL_PREFIX}myHandler`,
                expected: `${BACKEND_VIRTUAL_PREFIX}myHandler`,
            },
            {
                description: 'return null for non-backend module',
                input: 'some-other-module',
                expected: null,
            },
            {
                description: 'return null for empty string',
                input: '',
                expected: null,
            },
        ];

        test.each(cases)('Should $description', ({ input, expected }) => {
            const plugin = getBackendPlugin(functions, new Map(), log);
            const resolveId = plugin.resolveId as Function;
            expect(resolveId(input, undefined, {})).toBe(expected);
        });
    });

    describe('load', () => {
        test('Should return virtual entry content for known function', () => {
            const plugin = getBackendPlugin(functions, new Map(), log);
            const load = plugin.load as Function;
            const content = load(`${BACKEND_VIRTUAL_PREFIX}myHandler`);
            expect(content).toContain('import { myHandler }');
            expect(content).toContain('export async function main($)');
        });

        test('Should return null and log error for unknown function', () => {
            const plugin = getBackendPlugin(functions, new Map(), log);
            const load = plugin.load as Function;
            const content = load(`${BACKEND_VIRTUAL_PREFIX}unknownFunc`);
            expect(content).toBeNull();
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('Backend function "unknownFunc" not found'),
                'error',
            );
        });

        test('Should return null for non-prefixed ID', () => {
            const plugin = getBackendPlugin(functions, new Map(), log);
            const load = plugin.load as Function;
            expect(load('regular-module')).toBeNull();
        });
    });
});
