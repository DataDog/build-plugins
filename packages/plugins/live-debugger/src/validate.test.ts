// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, Options } from '@dd/core/types';

import { PLUGIN_NAME } from './constants';
import type { LiveDebuggerOptionsWithDefaults } from './types';
import { validateOptions } from './validate';

const mockLogger: Logger = {
    getLogger: jest.fn(() => mockLogger),
    time: jest.fn() as unknown as Logger['time'],
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
};

const makeConfig = (liveDebugger?: unknown, errorTracking?: unknown): Options =>
    ({ liveDebugger, errorTracking }) as unknown as Options;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('validateOptions', () => {
    describe('defaults', () => {
        const cases = [
            {
                description: 'disable when no options are provided',
                input: makeConfig(undefined),
                expected: {
                    enable: false,
                    version: undefined,
                    include: [/\.[jt]sx?$/],
                    exclude: expect.arrayContaining([/\/node_modules\//]),
                    honorSkipComments: true,
                    functionTypes: undefined,
                    namedOnly: false,
                } satisfies LiveDebuggerOptionsWithDefaults,
            },
            {
                description: 'honor enable: false even when the config key is present',
                input: makeConfig({ enable: false }),
                expected: expect.objectContaining({ enable: false, version: undefined }),
            },
            {
                description: 'enable and return defaults when an empty object is provided',
                input: makeConfig({}),
                expected: {
                    enable: true,
                    version: undefined,
                    include: [/\.[jt]sx?$/],
                    exclude: expect.arrayContaining([/\/node_modules\//]),
                    honorSkipComments: true,
                    functionTypes: undefined,
                    namedOnly: false,
                } satisfies LiveDebuggerOptionsWithDefaults,
            },
            {
                description: 'honor enable: true when version is provided',
                input: makeConfig({ enable: true, version: '1.0.0' }),
                expected: expect.objectContaining({ enable: true, version: '1.0.0' }),
            },
            {
                description: 'enable when a config object with version is provided',
                input: makeConfig({ version: '1.0.0' }),
                expected: {
                    enable: true,
                    version: '1.0.0',
                    include: [/\.[jt]sx?$/],
                    exclude: expect.arrayContaining([/\/node_modules\//]),
                    honorSkipComments: true,
                    functionTypes: undefined,
                    namedOnly: false,
                } satisfies LiveDebuggerOptionsWithDefaults,
            },
        ];

        test.each(cases)('should $description', ({ input, expected }) => {
            expect(validateOptions(input, mockLogger)).toEqual(expected);
        });

        it('should apply all default exclude patterns', () => {
            const result = validateOptions(makeConfig({}), mockLogger);
            expect(result.exclude).toHaveLength(9);
        });
    });

    describe('valid options', () => {
        const cases = [
            {
                description: 'accept version as a string',
                input: makeConfig({ version: '1.0.0' }),
                expected: expect.objectContaining({ version: '1.0.0' }),
            },
            {
                description: 'accept string include patterns',
                input: makeConfig({ version: '1.0.0', include: ['src/'] }),
                expected: expect.objectContaining({ version: '1.0.0', include: ['src/'] }),
            },
            {
                description: 'accept RegExp include patterns',
                input: makeConfig({ version: '1.0.0', include: [/\.tsx?$/] }),
                expected: expect.objectContaining({ version: '1.0.0', include: [/\.tsx?$/] }),
            },
            {
                description: 'accept mixed include patterns',
                input: makeConfig({ version: '1.0.0', include: ['src/', /\.tsx?$/] }),
                expected: expect.objectContaining({
                    version: '1.0.0',
                    include: ['src/', /\.tsx?$/],
                }),
            },
            {
                description: 'accept string exclude patterns',
                input: makeConfig({ version: '1.0.0', exclude: ['vendor/'] }),
                expected: expect.objectContaining({ version: '1.0.0', exclude: ['vendor/'] }),
            },
            {
                description: 'accept RegExp exclude patterns',
                input: makeConfig({ version: '1.0.0', exclude: [/node_modules/] }),
                expected: expect.objectContaining({ version: '1.0.0', exclude: [/node_modules/] }),
            },
            {
                description: 'accept honorSkipComments as true',
                input: makeConfig({ version: '1.0.0', honorSkipComments: true }),
                expected: expect.objectContaining({ version: '1.0.0', honorSkipComments: true }),
            },
            {
                description: 'accept honorSkipComments as false',
                input: makeConfig({ version: '1.0.0', honorSkipComments: false }),
                expected: expect.objectContaining({ version: '1.0.0', honorSkipComments: false }),
            },
            {
                description: 'accept valid functionTypes',
                input: makeConfig({
                    version: '1.0.0',
                    functionTypes: ['arrowFunction', 'classMethod'],
                }),
                expected: expect.objectContaining({
                    version: '1.0.0',
                    functionTypes: ['arrowFunction', 'classMethod'],
                }),
            },
            {
                description: 'accept all valid functionTypes',
                input: makeConfig({
                    version: '1.0.0',
                    functionTypes: [
                        'functionDeclaration',
                        'functionExpression',
                        'arrowFunction',
                        'objectMethod',
                        'classMethod',
                        'classPrivateMethod',
                    ],
                }),
                expected: expect.objectContaining({
                    version: '1.0.0',
                    functionTypes: [
                        'functionDeclaration',
                        'functionExpression',
                        'arrowFunction',
                        'objectMethod',
                        'classMethod',
                        'classPrivateMethod',
                    ],
                }),
            },
            {
                description: 'accept namedOnly as true',
                input: makeConfig({ version: '1.0.0', namedOnly: true }),
                expected: expect.objectContaining({ version: '1.0.0', namedOnly: true }),
            },
            {
                description: 'accept namedOnly as false',
                input: makeConfig({ version: '1.0.0', namedOnly: false }),
                expected: expect.objectContaining({ version: '1.0.0', namedOnly: false }),
            },
            {
                description: 'accept an empty include array',
                input: makeConfig({ version: '1.0.0', include: [] }),
                expected: expect.objectContaining({ version: '1.0.0', include: [] }),
            },
            {
                description: 'accept an empty exclude array',
                input: makeConfig({ version: '1.0.0', exclude: [] }),
                expected: expect.objectContaining({ version: '1.0.0', exclude: [] }),
            },
            {
                description: 'accept an empty functionTypes array',
                input: makeConfig({ version: '1.0.0', functionTypes: [] }),
                expected: expect.objectContaining({ version: '1.0.0', functionTypes: [] }),
            },
        ];

        test.each(cases)('should $description', ({ input, expected }) => {
            expect(validateOptions(input, mockLogger)).toEqual(expected);
        });
    });

    describe('invalid include', () => {
        const cases = [
            {
                description: 'reject include when not an array',
                input: makeConfig({ include: 'src/' }),
                errorPattern: /include.*must be an array/,
            },
            {
                description: 'reject include with invalid pattern type',
                input: makeConfig({ include: [42] }),
                errorPattern: /include.*patterns must be strings or RegExp/,
            },
            {
                description: 'reject include with a mix of valid and invalid patterns',
                input: makeConfig({ include: [/\.ts$/, true] }),
                errorPattern: /include.*patterns must be strings or RegExp/,
            },
        ];

        test.each(cases)('should $description', ({ input, errorPattern }) => {
            expect(() => validateOptions(input, mockLogger)).toThrow(
                `Invalid configuration for ${PLUGIN_NAME}.`,
            );
            expect(mockLogger.error).toHaveBeenCalledWith(expect.stringMatching(errorPattern));
        });
    });

    describe('version validation', () => {
        it('should reject version when not a string', () => {
            expect(() => validateOptions(makeConfig({ version: 123 }), mockLogger)).toThrow(
                `Invalid configuration for ${PLUGIN_NAME}.`,
            );
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringMatching(/version.*must be a string/),
            );
        });

        it('should reject version mismatch with sourcemap releaseVersion', () => {
            expect(() =>
                validateOptions(
                    makeConfig(
                        { version: '1.0.0' },
                        {
                            sourcemaps: {
                                releaseVersion: '2.0.0',
                            },
                        },
                    ),
                    mockLogger,
                ),
            ).toThrow(`Invalid configuration for ${PLUGIN_NAME}.`);
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringMatching(
                    /version.*must match.*errorTracking\.sourcemaps\.releaseVersion/,
                ),
            );
        });
    });

    describe('invalid exclude', () => {
        const cases = [
            {
                description: 'reject exclude when not an array',
                input: makeConfig({ exclude: /node_modules/ }),
                errorPattern: /exclude.*must be an array/,
            },
            {
                description: 'reject exclude with invalid pattern type',
                input: makeConfig({ exclude: [null] }),
                errorPattern: /exclude.*patterns must be strings or RegExp/,
            },
        ];

        test.each(cases)('should $description', ({ input, errorPattern }) => {
            expect(() => validateOptions(input, mockLogger)).toThrow(
                `Invalid configuration for ${PLUGIN_NAME}.`,
            );
            expect(mockLogger.error).toHaveBeenCalledWith(expect.stringMatching(errorPattern));
        });
    });

    describe('invalid enable', () => {
        const cases = [
            {
                description: 'reject enable when a string',
                input: makeConfig({ enable: 'yes' }),
            },
            {
                description: 'reject enable when a number',
                input: makeConfig({ enable: 1 }),
            },
        ];

        test.each(cases)('should $description', ({ input }) => {
            expect(() => validateOptions(input, mockLogger)).toThrow(
                `Invalid configuration for ${PLUGIN_NAME}.`,
            );
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringMatching(/enable.*must be a boolean/),
            );
        });
    });

    describe('invalid honorSkipComments', () => {
        const cases = [
            {
                description: 'reject honorSkipComments when not a boolean',
                input: makeConfig({ honorSkipComments: 'true' }),
            },
            {
                description: 'reject honorSkipComments when a number',
                input: makeConfig({ honorSkipComments: 1 }),
            },
        ];

        test.each(cases)('should $description', ({ input }) => {
            expect(() => validateOptions(input, mockLogger)).toThrow(
                `Invalid configuration for ${PLUGIN_NAME}.`,
            );
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringMatching(/honorSkipComments.*must be a boolean/),
            );
        });
    });

    describe('invalid functionTypes', () => {
        const cases = [
            {
                description: 'reject functionTypes when not an array',
                input: makeConfig({ functionTypes: 'arrowFunction' }),
                errorPattern: /functionTypes.*must be an array/,
            },
            {
                description: 'reject functionTypes with an invalid value',
                input: makeConfig({ functionTypes: ['arrowFunction', 'lambda'] }),
                errorPattern: /functionTypes.*contains invalid value "lambda"/,
            },
        ];

        test.each(cases)('should $description', ({ input, errorPattern }) => {
            expect(() => validateOptions(input, mockLogger)).toThrow(
                `Invalid configuration for ${PLUGIN_NAME}.`,
            );
            expect(mockLogger.error).toHaveBeenCalledWith(expect.stringMatching(errorPattern));
        });
    });

    describe('invalid namedOnly', () => {
        const cases = [
            {
                description: 'reject namedOnly when not a boolean',
                input: makeConfig({ namedOnly: 'yes' }),
            },
            {
                description: 'reject namedOnly when a number',
                input: makeConfig({ namedOnly: 0 }),
            },
        ];

        test.each(cases)('should $description', ({ input }) => {
            expect(() => validateOptions(input, mockLogger)).toThrow(
                `Invalid configuration for ${PLUGIN_NAME}.`,
            );
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringMatching(/namedOnly.*must be a boolean/),
            );
        });
    });

    describe('multiple errors', () => {
        it('should aggregate all validation errors before throwing', () => {
            const input = makeConfig({
                enable: 'yes',
                include: 'bad',
                exclude: 'bad',
                honorSkipComments: 42,
                functionTypes: 'bad',
                namedOnly: 42,
            });

            expect(() => validateOptions(input, mockLogger)).toThrow(
                `Invalid configuration for ${PLUGIN_NAME}.`,
            );

            const errorMessage = (mockLogger.error as jest.Mock).mock.calls[0][0] as string;
            expect(errorMessage).toMatch(/enable/);
            expect(errorMessage).toMatch(/include/);
            expect(errorMessage).toMatch(/exclude/);
            expect(errorMessage).toMatch(/honorSkipComments/);
            expect(errorMessage).toMatch(/functionTypes/);
            expect(errorMessage).toMatch(/namedOnly/);
        });
    });
});
