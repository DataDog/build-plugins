// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { DEFAULT_SITE } from '@dd/core/constants';
import type { Options } from '@dd/core/types';
import { clearDatadogEnv } from '@dd/tests/_jest/helpers/datadogEnv';

import { validateOptions } from './validate';

describe('factory validateOptions', () => {
    describe('defaults', () => {
        it('should return defaults when no options are provided', () => {
            expect(validateOptions()).toEqual(
                expect.objectContaining({
                    enableGit: true,
                    logLevel: 'warn',
                    metadata: {},
                }),
            );
        });

        it('should preserve user-provided metadata', () => {
            const result = validateOptions({
                metadata: { name: 'my-build', version: '1.0.0' },
            });
            expect(result.metadata).toEqual({ name: 'my-build', version: '1.0.0' });
        });

        it('should accept metadata with only name set', () => {
            const result = validateOptions({ metadata: { name: 'my-build' } });
            expect(result.metadata).toEqual({ name: 'my-build' });
        });

        it('should accept metadata with only version set', () => {
            const result = validateOptions({ metadata: { version: '1.0.0' } });
            expect(result.metadata).toEqual({ version: '1.0.0' });
        });

        it('should accept metadata with a service', () => {
            const result = validateOptions({ metadata: { service: 'checkout' } });
            expect(result.metadata).toEqual({ service: 'checkout' });
        });

        it('should accept an empty metadata block', () => {
            const result = validateOptions({ metadata: {} });
            expect(result.metadata).toEqual({});
        });
    });

    // Exercises validateOptions' own wiring (defaulting, error aggregation) around
    // parseSite. Site-format parsing itself (subdomains, case-insensitivity, rejection
    // rules) is unit-tested directly in `@dd/core/helpers/site`'s own test file.
    describe('auth.site', () => {
        it('should default to the default site when unset', () => {
            const result = validateOptions();
            expect(result.auth.site).toBe('datadoghq.com');
        });

        it('should resolve a custom subdomain to its base site', () => {
            const result = validateOptions({
                auth: { site: 'customsubdomain.us5.datadoghq.com' },
            });
            expect(result.auth.site).toBe('us5.datadoghq.com');
        });

        it('should reject a site that is not a known site or subdomain of one with an aggregated validation error', () => {
            expect(() =>
                validateOptions({ auth: { site: 'not-a-real-site.example.com' } }),
            ).toThrow(/auth\.site.*is not a supported Datadog site/);
        });
    });

    describe('site resolution from the environment and auth.site', () => {
        let restoreEnv: () => void;

        beforeEach(() => {
            restoreEnv = clearDatadogEnv();
        });

        afterEach(() => {
            restoreEnv();
        });

        // Plain JS configs can pass these values, which Options can't express.
        const nullSiteOptions: Options = JSON.parse('{ "auth": { "site": null } }');
        const numberSiteOptions: Options = JSON.parse('{ "auth": { "site": 123 } }');
        const booleanSiteOptions: Options = JSON.parse('{ "auth": { "site": true } }');
        const arraySiteOptions: Options = JSON.parse('{ "auth": { "site": ["datadoghq.eu"] } }');
        const objectSiteOptions: Options = JSON.parse(
            '{ "auth": { "site": { "apiKey": "abc123" } } }',
        );
        const nullPrototypeSiteOptions: Options = { auth: { site: Object.create(null) } };

        const cases = [
            {
                description: 'treat an empty DD_SITE as unset',
                env: { DD_SITE: '' },
                options: {},
                expected: DEFAULT_SITE,
            },
            {
                description: 'treat an empty DATADOG_SITE as unset',
                env: { DATADOG_SITE: '' },
                options: {},
                expected: DEFAULT_SITE,
            },
            {
                description: 'fall back to DD_SITE when DATADOG_SITE is empty',
                env: { DATADOG_SITE: '', DD_SITE: 'datadoghq.eu' },
                options: {},
                expected: 'datadoghq.eu',
            },
            {
                description: 'fall back to auth.site when DD_SITE is empty',
                env: { DD_SITE: '' },
                options: { auth: { site: 'datadoghq.eu' } },
                expected: 'datadoghq.eu',
            },
            {
                description: 'prefer a valid DD_SITE over auth.site',
                env: { DD_SITE: 'datadoghq.eu' },
                options: { auth: { site: 'us5.datadoghq.com' } },
                expected: 'datadoghq.eu',
            },
            {
                description: 'treat an empty auth.site as unset',
                env: {},
                options: { auth: { site: '' } },
                expected: DEFAULT_SITE,
            },
            {
                description: 'treat an empty auth.site as unset when DD_SITE is also empty',
                env: { DD_SITE: '' },
                options: { auth: { site: '' } },
                expected: DEFAULT_SITE,
            },
            {
                description: 'accept the UK1 site from DD_SITE',
                env: { DD_SITE: 'uk1.datadoghq.com' },
                options: {},
                expected: 'uk1.datadoghq.com',
            },
            {
                description: 'trim surrounding whitespace from DD_SITE',
                env: { DD_SITE: ' datadoghq.eu\n' },
                options: {},
                expected: 'datadoghq.eu',
            },
            {
                description: 'prefer a padded DATADOG_SITE over DD_SITE',
                env: { DATADOG_SITE: ' us5.datadoghq.com ', DD_SITE: 'datadoghq.eu' },
                options: {},
                expected: 'us5.datadoghq.com',
            },
            {
                description: 'trim surrounding whitespace from auth.site',
                env: {},
                options: { auth: { site: '  datadoghq.eu\t' } },
                expected: 'datadoghq.eu',
            },
            {
                description: 'accept a URL-shaped DD_SITE',
                env: { DD_SITE: 'https://app.datadoghq.eu/apm/home' },
                options: {},
                expected: 'datadoghq.eu',
            },
            {
                description: 'treat a null auth.site as unset',
                env: {},
                options: nullSiteOptions,
                expected: DEFAULT_SITE,
            },
        ];

        test.each(cases)('should $description', ({ env, options, expected }) => {
            Object.assign(process.env, env);
            expect(validateOptions(options).auth.site).toBe(expected);
        });

        const rejectionCases = [
            {
                description: 'an unsupported DD_SITE',
                env: { DD_SITE: 'not-a-real-site.example.com' },
                options: {},
                expectedError:
                    'DATADOG_SITE/DD_SITE "not-a-real-site.example.com" is not a supported',
            },
            {
                description: 'an unsupported DD_SITE, even with a valid auth.site',
                env: { DD_SITE: 'not-a-real-site.example.com' },
                options: { auth: { site: 'datadoghq.eu' } },
                expectedError:
                    'DATADOG_SITE/DD_SITE "not-a-real-site.example.com" is not a supported',
            },
            {
                description: 'a whitespace-only DD_SITE',
                env: { DD_SITE: '  ' },
                options: {},
                expectedError: 'DATADOG_SITE/DD_SITE "  " is not a supported',
            },
            {
                description: 'a whitespace-only DATADOG_SITE, even with a valid DD_SITE',
                env: { DATADOG_SITE: '  ', DD_SITE: 'datadoghq.eu' },
                options: {},
                expectedError: 'DATADOG_SITE/DD_SITE "  " is not a supported',
            },
            {
                description: 'a DD_SITE with an inner tab, escaped in the message',
                env: { DD_SITE: 'datadoghq\t.eu' },
                options: {},
                expectedError: 'DATADOG_SITE/DD_SITE "datadoghq\\t.eu" is not a supported',
            },
            {
                description: 'a whitespace-only auth.site',
                env: {},
                options: { auth: { site: '  ' } },
                expectedError: 'auth.site "  " is not a supported',
            },
            {
                description: 'an auth.site with an inner newline, escaped in the message',
                env: {},
                options: { auth: { site: 'datadoghq.eu\nus5.datadoghq.com' } },
                expectedError: 'auth.site "datadoghq.eu\\nus5.datadoghq.com" is not a supported',
            },
            {
                description: 'a number auth.site',
                env: {},
                options: numberSiteOptions,
                expectedError: 'auth.site 123 is not a supported',
            },
            {
                description: 'a boolean auth.site',
                env: {},
                options: booleanSiteOptions,
                expectedError: 'auth.site true is not a supported',
            },
            {
                description: 'an array auth.site without printing its contents',
                env: {},
                options: arraySiteOptions,
                expectedError: 'auth.site array is not a supported',
            },
            {
                description: 'an object auth.site without printing its fields',
                env: {},
                options: objectSiteOptions,
                expectedError: 'auth.site object is not a supported',
            },
            {
                description: 'a null-prototype object auth.site with the standard validation error',
                env: {},
                options: nullPrototypeSiteOptions,
                expectedError: 'auth.site object is not a supported',
            },
        ];

        test.each(rejectionCases)(
            'should reject $description',
            ({ env, options, expectedError }) => {
                Object.assign(process.env, env);
                expect(() => validateOptions(options)).toThrow(expectedError);
            },
        );

        const unprintedContentCases = [
            { description: 'an array', options: arraySiteOptions, content: /datadoghq\.eu/ },
            { description: 'an object', options: objectSiteOptions, content: /abc123/ },
        ];

        test.each(unprintedContentCases)(
            'should not print the contents of $description auth.site',
            ({ options, content }) => {
                expect(() => validateOptions(options)).toThrow('is not a supported');
                expect(() => validateOptions(options)).not.toThrow(content);
            },
        );
    });

    describe('metadata validation', () => {
        const cases = [
            {
                description: 'reject metadata.version when not a string',
                input: { metadata: { version: 123 } },
                errorPattern: /metadata\.version.*must be a string/,
            },
            {
                description: 'reject metadata.version when null',
                input: { metadata: { version: null } },
                errorPattern: /metadata\.version.*must be a string/,
            },
            {
                description: 'reject metadata.service when not a string',
                input: { metadata: { service: 123 } },
                errorPattern: /metadata\.service.*must be a string/,
            },
        ];

        test.each(cases)('should $description', ({ input, errorPattern }) => {
            expect(() => validateOptions(input as unknown as Options)).toThrow(errorPattern);
        });

        it('should accept non-string metadata.name for backwards compatibility', () => {
            expect(() =>
                validateOptions({ metadata: { name: 123 } } as unknown as Options),
            ).not.toThrow();
            expect(() =>
                validateOptions({ metadata: { name: null } } as unknown as Options),
            ).not.toThrow();
        });
    });

    describe('sourcemaps', () => {
        it('should normalize debug ID injection without upload', () => {
            expect(validateOptions({ sourcemaps: { debugId: true } })).toEqual(
                expect.objectContaining({
                    rum: { sourceCodeContext: { debugId: true } },
                }),
            );
            expect(
                validateOptions({ sourcemaps: { debugId: true } }).errorTracking,
            ).toBeUndefined();
        });

        it('should normalize debug ID injection and upload options', () => {
            expect(
                validateOptions({
                    sourcemaps: {
                        bailOnError: true,
                        debugId: true,
                        dryRun: true,
                        experimentalDuplicateCheck: true,
                        maxConcurrency: 5,
                        upload: true,
                    },
                }),
            ).toEqual(
                expect.objectContaining({
                    errorTracking: {
                        sourcemaps: {
                            bailOnError: true,
                            debugId: true,
                            dryRun: true,
                            experimentalDuplicateCheck: true,
                            maxConcurrency: 5,
                        },
                    },
                    rum: { sourceCodeContext: { debugId: true } },
                }),
            );
        });

        it('should leave omitted upload options unset for downstream defaults', () => {
            expect(
                validateOptions({ sourcemaps: { debugId: true, upload: true } }).errorTracking,
            ).toEqual({ sourcemaps: { debugId: true } });
        });

        it('should preserve source code context metadata while enabling debug IDs', () => {
            expect(
                validateOptions({
                    metadata: { version: '1.2.3' },
                    rum: { sourceCodeContext: { service: 'checkout' } },
                    sourcemaps: { debugId: true, upload: true },
                }),
            ).toEqual(
                expect.objectContaining({
                    rum: {
                        sourceCodeContext: {
                            debugId: true,
                            service: 'checkout',
                        },
                    },
                }),
            );
        });

        it.each([
            {
                input: { sourcemaps: { debugId: false } },
                error: /sourcemaps\.debugId must be true/,
            },
            {
                input: { sourcemaps: { debugId: true, upload: 'yes' } },
                error: /sourcemaps\.upload must be a boolean/,
            },
            {
                input: { sourcemaps: { bailOnError: true, debugId: true } },
                error: /require sourcemaps\.upload to be true/,
            },
            {
                input: { sourcemaps: { debugId: true, experimentalDuplicateCheck: true } },
                error: /require sourcemaps\.upload to be true/,
            },
            {
                input: {
                    rum: { sourceCodeContext: { debugId: false, service: 'checkout' } },
                    sourcemaps: { debugId: true },
                },
                error: /rum\.sourceCodeContext\.debugId cannot be false/,
            },
            {
                input: {
                    errorTracking: { sourcemaps: { debugId: true } },
                    sourcemaps: { debugId: true, upload: true },
                },
                error: /cannot be combined with errorTracking\.sourcemaps/,
            },
        ])('should reject invalid or conflicting configuration', ({ input, error }) => {
            expect(() => validateOptions(input as unknown as Options)).toThrow(error);
        });
    });
});
