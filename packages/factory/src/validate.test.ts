// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';

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

        it('should accept an empty metadata block', () => {
            const result = validateOptions({ metadata: {} });
            expect(result.metadata).toEqual({});
        });
    });

    describe('auth.site', () => {
        it('should default to the default site when unset', () => {
            const result = validateOptions();
            expect(result.auth.site).toBe('datadoghq.com');
            expect(result.auth.siteSubdomain).toBeUndefined();
        });

        it('should accept a bare known site unchanged', () => {
            const result = validateOptions({ auth: { site: 'us5.datadoghq.com' } });
            expect(result.auth.site).toBe('us5.datadoghq.com');
            expect(result.auth.siteSubdomain).toBeUndefined();
        });

        it('should accept a custom subdomain on top of a known site', () => {
            const result = validateOptions({
                auth: { site: 'customsubdomain.us5.datadoghq.com' },
            });
            expect(result.auth.site).toBe('us5.datadoghq.com');
            expect(result.auth.siteSubdomain).toBe('customsubdomain');
        });

        it('should accept a custom subdomain on top of a bare site', () => {
            const result = validateOptions({ auth: { site: 'foobar.datadoghq.com' } });
            expect(result.auth.site).toBe('datadoghq.com');
            expect(result.auth.siteSubdomain).toBe('foobar');
        });

        it('should reject a site that is not a known site or subdomain of one', () => {
            expect(() =>
                validateOptions({ auth: { site: 'not-a-real-site.example.com' } }),
            ).toThrow(/auth\.site.*is not a supported Datadog site/);
        });

        it('should reject a subdomain with multiple labels', () => {
            expect(() => validateOptions({ auth: { site: 'foo.bar.datadoghq.com' } })).toThrow(
                /auth\.site.*is not a supported Datadog site/,
            );
        });

        it('should match case-insensitively and normalize to lowercase', () => {
            const result = validateOptions({
                auth: { site: 'CustomSubdomain.US5.DatadogHQ.com' },
            });
            expect(result.auth.site).toBe('us5.datadoghq.com');
            expect(result.auth.siteSubdomain).toBe('customsubdomain');
        });

        it('should reject a non-string site value with the standard validation error, not throw internally', () => {
            expect(() =>
                // Plain JS configs aren't enforced by the type system at runtime.
                validateOptions({ auth: { site: 123 as unknown as string } }),
            ).toThrow(/auth\.site.*is not a supported Datadog site/);
        });
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
});
