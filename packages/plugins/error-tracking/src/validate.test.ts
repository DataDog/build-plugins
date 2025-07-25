// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { SourcemapsOptions } from '@dd/error-tracking-plugin/types';
import { validateOptions, validateSourcemapsOptions } from '@dd/error-tracking-plugin/validate';
import { mockLogger, getMinimalSourcemapsConfiguration } from '@dd/tests/_jest/helpers/mocks';
import stripAnsi from 'strip-ansi';

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
                enableGit: true,
                maxConcurrency: 20,
                intakeUrl: 'https://sourcemap-intake.datadoghq.com/api/v2/srcmap',
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

        test('Should default to the expected intake url', () => {
            const { config } = validateSourcemapsOptions({
                errorTracking: {
                    sourcemaps: getMinimalSourcemapsConfiguration(),
                },
            });

            expect(config?.intakeUrl).toBe('https://sourcemap-intake.datadoghq.com/api/v2/srcmap');
        });

        test('Should use the provided configuration as the intake url', () => {
            const { config } = validateSourcemapsOptions({
                errorTracking: {
                    sourcemaps: getMinimalSourcemapsConfiguration({
                        intakeUrl: 'https://example.com',
                    }),
                },
            });

            expect(config?.intakeUrl).toBe('https://example.com');
        });

        test('Should use the env var if provided as the intake url', () => {
            const initialEnvValue = process.env.DATADOG_SOURCEMAP_INTAKE_URL;
            process.env.DATADOG_SOURCEMAP_INTAKE_URL = 'https://example.com';
            const { config } = validateSourcemapsOptions({
                errorTracking: {
                    sourcemaps: getMinimalSourcemapsConfiguration(),
                },
            });

            expect(config?.intakeUrl).toBe('https://example.com');
            process.env.DATADOG_SOURCEMAP_INTAKE_URL = initialEnvValue;
        });
    });
});
