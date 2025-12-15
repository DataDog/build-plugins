// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { validateOptions } from '@dd/apps-plugin/validate';

describe('Apps Plugin - validateOptions', () => {
    describe('enable flag', () => {
        const cases = [
            {
                description: 'return false when no apps config is provided',
                input: {},
                expected: false,
            },
            {
                description: 'return true when apps config is an empty object',
                input: { apps: {} },
                expected: true,
            },
            {
                description: 'respect explicit enable true',
                input: { apps: { enable: true } },
                expected: true,
            },
            {
                description: 'respect explicit enable false',
                input: { apps: { enable: false } },
                expected: false,
            },
        ];

        test.each(cases)('Should $description', ({ input, expected }) => {
            const result = validateOptions(input);
            expect(result.enable).toBe(expected);
        });
    });

    describe('defaults', () => {
        test('Should set defaults when nothing is provided', () => {
            const result = validateOptions({});
            expect(result).toEqual({
                dryRun: false,
                enable: false,
                include: [],
                identifier: undefined,
            });
        });
    });

    describe('overrides', () => {
        test('Should keep provided options and trim identifier', () => {
            const result = validateOptions({
                apps: {
                    dryRun: true,
                    enable: true,
                    include: ['public/**/*', 'dist/**/*'],
                    identifier: '  my-app  ',
                },
            });

            expect(result).toEqual({
                dryRun: true,
                enable: true,
                include: ['public/**/*', 'dist/**/*'],
                identifier: 'my-app',
            });
        });
    });
});
