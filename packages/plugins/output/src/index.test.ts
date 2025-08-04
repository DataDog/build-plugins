// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getPlugins, getFilePath } from '@dd/output-plugin';
import { getGetPluginsArg } from '@dd/tests/_jest/helpers/mocks';

describe('Output Plugin', () => {
    describe('getPlugins', () => {
        test('Should not initialize the plugin if not enabled', async () => {
            expect(getPlugins(getGetPluginsArg({ output: { enable: false } }))).toHaveLength(0);
            expect(getPlugins(getGetPluginsArg())).toHaveLength(0);
        });

        test('Should initialize the plugin if enabled', async () => {
            expect(getPlugins(getGetPluginsArg({ output: { enable: true } }))).toHaveLength(1);
        });
    });

    describe('getFilePath', () => {
        const cases = [
            {
                description: 'resolve relative path with filename',
                outDir: '/project/dist',
                pathOption: './',
                filename: 'build.json',
                expected: '/project/dist/build.json',
            },
            {
                description: 'resolve relative subdirectory with filename',
                outDir: '/project/dist',
                pathOption: './reports',
                filename: 'metrics.json',
                expected: '/project/dist/reports/metrics.json',
            },
            {
                description: 'handle absolute path ignoring outDir',
                outDir: '/project/dist',
                pathOption: '/absolute/reports',
                filename: 'errors.json',
                expected: '/absolute/reports/errors.json',
            },
            {
                description: 'resolve parent directory path',
                outDir: '/project/dist',
                pathOption: '../output',
                filename: 'logs.json',
                expected: '/project/output/logs.json',
            },
            {
                description: 'handle nested relative paths',
                outDir: '/project/dist',
                pathOption: './data/reports',
                filename: 'warnings.json',
                expected: '/project/dist/data/reports/warnings.json',
            },
            {
                description: 'handle filename with path',
                outDir: '/project/dist',
                pathOption: './',
                filename: 'subfolder/build.json',
                expected: '/project/dist/subfolder/build.json',
            },
            {
                description: 'handle empty path option as current directory',
                outDir: '/project/dist',
                pathOption: '',
                filename: 'bundler.json',
                expected: '/project/dist/bundler.json',
            },
            {
                description: 'normalize paths with multiple slashes',
                outDir: '/project/dist/',
                pathOption: './reports/',
                filename: 'dependencies.json',
                expected: '/project/dist/reports/dependencies.json',
            },
        ];

        test.each(cases)('Should $description', ({ outDir, pathOption, filename, expected }) => {
            const result = getFilePath(outDir, pathOption, filename);
            expect(result).toBe(expected);
        });
    });
});
