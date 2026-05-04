// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { createFilter } from '@rollup/pluginutils';

import { validatePrivacyOptions, validateSourceCodeContextOptions } from './validate';

describe('Test privacy plugin option exclude regex', () => {
    let filter: (path: string) => boolean;
    const testCases = [
        { description: 'exclude .preval files', path: '.preval.js', expected: false },
        { description: 'exclude node_modules', path: '/node_modules/test.js', expected: false },
        {
            description: 'exclude all files that start with special characters',
            path: '!test.js',
            expected: false,
        },
        {
            description: 'exclude all files that start with special characters',
            path: '@test.js',
            expected: false,
        },
    ];

    beforeAll(() => {
        const pluginOptions = { ...defaultPluginOptions, rum: { privacy: {} } };
        const { config } = validatePrivacyOptions(pluginOptions);
        filter = createFilter(config?.include, config?.exclude);
    });

    test.each(testCases)('Should $description', ({ path, expected }) => {
        expect(filter(path)).toBe(expected);
    });
});

describe('sourceCodeContext validation', () => {
    test('should return empty result when not configured', () => {
        const pluginOptions = { ...defaultPluginOptions, rum: {} };
        const result = validateSourceCodeContextOptions(pluginOptions);
        expect(result.errors).toHaveLength(0);
        expect(result.config).toBeUndefined();
    });

    test('should accept when only service is provided (version optional)', () => {
        const pluginOptions = {
            ...defaultPluginOptions,
            rum: { sourceCodeContext: { service: 'checkout' } },
        };
        const result = validateSourceCodeContextOptions(pluginOptions);
        expect(result.errors).toHaveLength(0);
        expect(result.config).toEqual(expect.objectContaining({ service: 'checkout' }));
    });

    test('should error when service is missing', () => {
        const pluginOptions = {
            ...defaultPluginOptions,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rum: { sourceCodeContext: { version: '1.2.3' } as any },
        };
        const result = validateSourceCodeContextOptions(pluginOptions);
        expect(result.errors).toEqual(
            expect.arrayContaining([expect.stringContaining('"rum.sourceCodeContext.service"')]),
        );
    });
});
