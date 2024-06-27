// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { RumSourcemapsOptions } from '@dd/rum-plugins/types';
import { validateOptions, validateSourcemapsOptions } from '@dd/rum-plugins/validate';
import stripAnsi from 'strip-ansi';

import { getMinimalSourcemapsConfiguration } from './testHelpers';

describe('RUM Plugins validate', () => {
    describe('validateOptions', () => {
        test('It should return the validated configuration', () => {
            const config = validateOptions({
                auth: {
                    apiKey: '123',
                },
                rum: {
                    disabled: false,
                },
            });

            expect(config).toEqual({
                disabled: false,
            });
        });

        test('It should throw with an invalid configuration', () => {
            expect(() => {
                validateOptions({
                    auth: {
                        apiKey: '123',
                    },
                    rum: {
                        // Invalid configuration, missing required fields.
                        sourcemaps: {} as RumSourcemapsOptions,
                    },
                });
            }).toThrow();
        });
    });
    describe('validateSourcemapsOptions', () => {
        test('It should return errors for each missing required field', () => {
            const { errors } = validateSourcemapsOptions({
                rum: {
                    sourcemaps: {} as RumSourcemapsOptions,
                },
            });

            expect(errors.length).toBe(4);
            const expectedErrors = [
                'sourcemaps.basePath is required.',
                'sourcemaps.releaseVersion is required.',
                'sourcemaps.service is required.',
                'sourcemaps.minifiedPathPrefix is required.',
            ];
            expect(errors.map(stripAnsi)).toEqual(expectedErrors);
        });

        test('It should return the validated configuration with defaults', () => {
            const configObject: RumSourcemapsOptions = {
                basePath: 'src',
                minifiedPathPrefix: '/path/to/minified',
                releaseVersion: '1.0.0',
                service: 'service',
            };

            const { config, errors } = validateSourcemapsOptions({
                rum: {
                    sourcemaps: getMinimalSourcemapsConfiguration(configObject),
                },
            });

            expect(errors.length).toBe(0);
            expect(config).toEqual({
                dryRun: false,
                maxConcurrency: 20,
                intakeUrl: 'https://sourcemap-intake.datadoghq.com/api/v2/srcmap',
                ...configObject,
            });
        });

        test('It should return an error with a bad minifiedPathPrefix', () => {
            const { errors } = validateSourcemapsOptions({
                rum: {
                    sourcemaps: getMinimalSourcemapsConfiguration({
                        minifiedPathPrefix:
                            'bad-prefix' as RumSourcemapsOptions['minifiedPathPrefix'],
                    }),
                },
            });

            expect(errors.length).toBe(1);
            expect(stripAnsi(errors[0])).toBe(
                "sourcemaps.minifiedPathPrefix must be a valid URL or start with '/'.",
            );
        });

        test('It should default to the expected intake url', () => {
            const { config } = validateSourcemapsOptions({
                rum: {
                    sourcemaps: getMinimalSourcemapsConfiguration(),
                },
            });

            expect(config?.intakeUrl).toBe('https://sourcemap-intake.datadoghq.com/api/v2/srcmap');
        });

        test('It should use the provided configuration as the intake url', () => {
            const { config } = validateSourcemapsOptions({
                rum: {
                    sourcemaps: getMinimalSourcemapsConfiguration({
                        intakeUrl: 'https://example.com',
                    }),
                },
            });

            expect(config?.intakeUrl).toBe('https://example.com');
        });

        test('It should use the env var if provided as the intake url', () => {
            const initialEnvValue = process.env.DATADOG_SOURCEMAP_INTAKE_URL;
            process.env.DATADOG_SOURCEMAP_INTAKE_URL = 'https://example.com';
            const { config } = validateSourcemapsOptions({
                rum: {
                    sourcemaps: getMinimalSourcemapsConfiguration(),
                },
            });

            expect(config?.intakeUrl).toBe('https://example.com');
            process.env.DATADOG_SOURCEMAP_INTAKE_URL = initialEnvValue;
        });
    });
});
