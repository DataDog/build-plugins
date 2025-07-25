// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { createFilter } from '@rollup/pluginutils';

import { validatePrivacyOptions } from './validate';

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    getLogger: jest.fn(),
    time: jest.fn(),
};

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
        const { config } = validatePrivacyOptions(pluginOptions, mockLogger);
        filter = createFilter(config?.include, config?.exclude);
    });

    test.each(testCases)('Should $description', ({ path, expected }) => {
        expect(filter(path)).toBe(expected);
    });
});
