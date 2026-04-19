// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { resetEnableWarnings } from '@dd/core/helpers/options';
import type { Logger } from '@dd/core/types';
import type { SourcemapsOptions } from '@dd/error-tracking-plugin/types';
import { validateOptions, validateSourcemapsOptions } from '@dd/error-tracking-plugin/validate';
import { getMinimalSourcemapsConfiguration } from '@dd/tests/_jest/helpers/mocks';
import stripAnsi from 'strip-ansi';

const mockLogger: Logger = {
    getLogger: jest.fn(() => mockLogger),
    time: jest.fn() as unknown as Logger['time'],
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
};

beforeEach(() => {
    jest.clearAllMocks();
    resetEnableWarnings();
});

describe('Error Tracking Plugins validate', () => {
    describe('validateOptions', () => {
        test('Should return the validated configuration', () => {
            const config = validateOptions(
                {
                    auth: {
                        apiKey: '123',
                    },
                    errorTracking: {
                        enable: true,
                    },
                },
                mockLogger,
            );

            expect(config).toEqual({
                enable: true,
            });
        });

        test('Should throw with an invalid configuration', () => {
            expect(() => {
                validateOptions(
                    {
                        auth: {
                            apiKey: '123',
                        },
                        errorTracking: {
                            // Invalid configuration, missing required fields.
                            sourcemaps: {} as SourcemapsOptions,
                        },
                    },
                    mockLogger,
                );
            }).toThrow();
        });
    });

    describe('enable flag', () => {
        const cases = [
            {
                description: 'return false when no errorTracking config is provided',
                input: {},
                expected: false,
            },
            {
                description: 'return true when errorTracking config is an empty object',
                input: { errorTracking: {} },
                expected: true,
            },
            {
                description: 'respect explicit enable true',
                input: { errorTracking: { enable: true } },
                expected: true,
            },
            {
                description: 'respect explicit enable false',
                input: { errorTracking: { enable: false } },
                expected: false,
            },
        ];

        test.each(cases)('Should $description', ({ input, expected }) => {
            const result = validateOptions(input, mockLogger);
            expect(result.enable).toBe(expected);
        });
    });

    describe('enable deprecation warning for non-boolean values', () => {
        test('Should coerce enable: 1 to true and warn', () => {
            const result = validateOptions(
                { errorTracking: { enable: 1 } } as unknown as Parameters<
                    typeof validateOptions
                >[0],
                mockLogger,
            );
            expect(result.enable).toBe(true);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('errorTracking.enable'),
            );
        });

        test('Should coerce enable: 0 to false and warn', () => {
            const result = validateOptions(
                { errorTracking: { enable: 0 } } as unknown as Parameters<
                    typeof validateOptions
                >[0],
                mockLogger,
            );
            expect(result.enable).toBe(false);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        });
    });
    describe('validateSourcemapsOptions', () => {
        test('Should return errors for each missing required field', () => {
            const { errors } = validateSourcemapsOptions({
                errorTracking: {
                    sourcemaps: {} as SourcemapsOptions,
                },
            });

            expect(errors).toHaveLength(3);
            const expectedErrors = [
                'sourcemaps.releaseVersion is required.',
                'sourcemaps.service is required.',
                'sourcemaps.minifiedPathPrefix is required.',
            ];
            expect(errors.map(stripAnsi)).toEqual(expectedErrors);
        });

        test('Should return the validated configuration with defaults', () => {
            const configObject: SourcemapsOptions = {
                minifiedPathPrefix: '/path/to/minified',
                releaseVersion: '1.0.0',
                service: 'service',
            };

            const { config, errors } = validateSourcemapsOptions({
                errorTracking: {
                    sourcemaps: getMinimalSourcemapsConfiguration(configObject),
                },
            });

            expect(errors).toHaveLength(0);
            expect(config).toEqual({
                bailOnError: false,
                dryRun: false,
                maxConcurrency: 20,
                ...configObject,
            });
        });

        test('Should return an error with a bad minifiedPathPrefix', () => {
            const { errors } = validateSourcemapsOptions({
                errorTracking: {
                    sourcemaps: getMinimalSourcemapsConfiguration({
                        minifiedPathPrefix: 'bad-prefix' as SourcemapsOptions['minifiedPathPrefix'],
                    }),
                },
            });

            expect(errors).toHaveLength(1);
            expect(stripAnsi(errors[0])).toBe(
                "sourcemaps.minifiedPathPrefix must be a valid URL or start with '/'.",
            );
        });
    });
});
