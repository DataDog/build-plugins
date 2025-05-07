// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import { defaultPluginOptions, getSourcemapsConfiguration } from '@dd/tests/_jest/helpers/mocks';

import type { Options } from '../types';

import { cleanPluginName, isInjectionFile, shouldGetGitInfo } from './plugins';

describe('plugins', () => {
    describe('cleanPluginName', () => {
        test.each([
            {
                description: 'remove datadog- prefix',
                input: 'datadog-awesome-stuff',
                result: 'awesome-stuff',
            },
            {
                description: 'remove @dd/ prefix',
                input: '@dd/awesome-stuff',
                result: 'awesome-stuff',
            },
            {
                description: 'remove -plugin suffix',
                input: 'awesome-plugin',
                result: 'awesome',
            },
            {
                description: 'remove prefix and suffix',
                input: 'datadog-awesome-plugin',
                result: 'awesome',
            },
            {
                description: 'handle multiple patterns',
                input: '@dd/datadog-awesome-plugin',
                result: 'awesome',
            },
            {
                description: 'handle multiple patterns',
                input: '@dd/internal-awesome-plugin',
                result: 'awesome',
            },
            {
                description: 'return the name unchanged if no patterns match',
                input: 'regular-name',
                result: 'regular-name',
            },
        ])('Should $description', ({ input, result }) => {
            expect(cleanPluginName(input)).toBe(result);
        });
    });

    describe('isInjectionFile', () => {
        test.each([
            {
                description: 'true with INJECTED_FILE in the middle',
                input: `path/to/${INJECTED_FILE}/file.js`,
                result: true,
            },
            {
                description: 'true with INJECTED_FILE at the beginning',
                input: `${INJECTED_FILE}/something`,
                result: true,
            },
            {
                description: 'true with INJECTED_FILE at the end',
                input: `path/to/${INJECTED_FILE}`,
                result: true,
            },
            {
                description: 'false with no INJECTED_FILE',
                input: 'path/to/regular-file.js',
                result: false,
            },
            {
                description: 'return false for empty string',
                input: '',
                result: false,
            },
        ])('Should $description', ({ input, result }) => {
            expect(isInjectionFile(input)).toBe(result);
        });
    });

    describe('shouldGetGitInfo', () => {
        const pluginOptions: Options = {
            ...defaultPluginOptions,
        };
        const sourcemapsOptions = getSourcemapsConfiguration();
        test.each([
            {
                description: 'true with sourcemaps',
                input: { ...pluginOptions, errorTracking: { sourcemaps: sourcemapsOptions } },
                result: true,
            },
            {
                description: 'false with no sourcemaps',
                input: { ...pluginOptions },
                result: false,
            },
            {
                description: 'false if disabled globaly',
                input: { ...pluginOptions, disableGit: true },
                result: false,
            },
            {
                description: 'false if disabled localy',
                input: {
                    ...pluginOptions,
                    errorTracking: { sourcemaps: { ...sourcemapsOptions, disableGit: true } },
                },
                result: false,
            },
        ])('Should be $description', ({ input, result }) => {
            expect(shouldGetGitInfo(input)).toBe(result);
        });
    });
});
