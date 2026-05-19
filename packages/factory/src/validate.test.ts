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
