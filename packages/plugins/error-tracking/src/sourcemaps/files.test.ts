// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Output } from '@dd/core/types';
import {
    joinUrlOrPath,
    decomposePath,
    getSourcemapsFiles,
} from '@dd/error-tracking-plugin/sourcemaps/files';
import { getSourcemapsConfiguration } from '@dd/tests/_jest/helpers/mocks';
import stripAnsi from 'strip-ansi';

import type { MinifiedPathPrefix } from '../types';

describe('Error Tracking Plugin Sourcemaps Files', () => {
    describe('joinUrlOrPath', () => {
        // Note that `minifiedPathPrefix` is validated to be a valid URL
        // or a string starting with a slash.
        const cases: {
            description: string;
            base: MinifiedPathPrefix;
            relativePath: string;
            expected: string;
        }[] = [
            {
                description: 'HTTPS URL with paths',
                base: 'https://cdn.example.com/static/',
                relativePath: '/app.js',
                expected: 'https://cdn.example.com/static/app.js',
            },
            {
                description: 'HTTPS URL without trailing slash',
                base: 'https://cdn.example.com/static',
                relativePath: 'app.js',
                expected: 'https://cdn.example.com/static/app.js',
            },
            {
                description: 'HTTP URL with subdirectory',
                base: 'http://localhost:3000/assets/',
                relativePath: 'components/Button.js',
                expected: 'http://localhost:3000/assets/components/Button.js',
            },
            {
                description: 'file paths with trailing slash',
                base: '/static/',
                relativePath: '/app.js',
                expected: '/static/app.js',
            },
            {
                description: 'file paths without trailing slash',
                base: '/static',
                relativePath: 'app.js',
                expected: '/static/app.js',
            },
            {
                description: 'nested file paths',
                base: '/assets/js',
                relativePath: 'components/Button.js',
                expected: '/assets/js/components/Button.js',
            },
        ];

        test.each(cases)('Should handle $description', ({ base, relativePath, expected }) => {
            expect(joinUrlOrPath(base, relativePath)).toBe(expected);
        });
    });

    describe('decomposePath', () => {
        const cases: Array<{
            description: string;
            absoluteOutDir: string;
            prefix: MinifiedPathPrefix;
            sourcemapFilePath: string;
            expected: {
                minifiedFilePath: string;
                relativePath: string;
                minifiedUrl: string;
            };
        }> = [
            {
                description: 'file in root of outDir',
                absoluteOutDir: '/build/dist',
                prefix: '/static/',
                sourcemapFilePath: '/build/dist/app.js.map',
                expected: {
                    minifiedFilePath: '/build/dist/app.js',
                    relativePath: 'app.js',
                    minifiedUrl: '/static/app.js',
                },
            },
            {
                description: 'file in subdirectory',
                absoluteOutDir: '/project/output',
                prefix: '/static/',
                sourcemapFilePath: '/project/output/assets/main.js.map',
                expected: {
                    minifiedFilePath: '/project/output/assets/main.js',
                    relativePath: 'assets/main.js',
                    minifiedUrl: '/static/assets/main.js',
                },
            },
            {
                description: 'complex nested path',
                absoluteOutDir: '/home/user/build/assets',
                prefix: '/static/',
                sourcemapFilePath: '/home/user/build/assets/components/Button.js.map',
                expected: {
                    minifiedFilePath: '/home/user/build/assets/components/Button.js',
                    relativePath: 'components/Button.js',
                    minifiedUrl: '/static/components/Button.js',
                },
            },
            {
                description: 'URL minified prefix',
                absoluteOutDir: '/build',
                prefix: 'https://cdn.example.com/static/',
                sourcemapFilePath: '/build/app.js.map',
                expected: {
                    minifiedFilePath: '/build/app.js',
                    relativePath: 'app.js',
                    minifiedUrl: 'https://cdn.example.com/static/app.js',
                },
            },
        ];

        test.each(cases)(
            'Should decompose $description',
            ({ absoluteOutDir, prefix, sourcemapFilePath, expected }) => {
                expect(decomposePath(prefix, absoluteOutDir, sourcemapFilePath)).toEqual(expected);
            },
        );

        test('Should throw error for non-sourcemap files', () => {
            let error: string;
            try {
                decomposePath('/static/', '/build', '/build/app.js');
            } catch (err: any) {
                error = stripAnsi(err.message);
            }
            expect(error!).toBe('The file /build/app.js is not a sourcemap.');
        });
    });

    describe('getSourcemapsFiles', () => {
        test('Should process multiple sourcemap files', () => {
            const options = getSourcemapsConfiguration({ minifiedPathPrefix: '/static/' });
            const outDir = '/build';
            const outputs: Output[] = [
                {
                    name: 'app.js',
                    filepath: '/build/app.js',
                    inputs: [],
                    size: 1000,
                    type: 'js',
                },
                {
                    name: 'app.js.map',
                    filepath: '/build/app.js.map',
                    inputs: [],
                    size: 500,
                    type: 'js',
                },
                {
                    name: 'vendor.js.map',
                    filepath: '/build/vendor.js.map',
                    inputs: [],
                    size: 800,
                    type: 'js',
                },
            ];

            const result = getSourcemapsFiles(options, {
                outDir,
                outputs,
            });

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                minifiedFilePath: '/build/app.js',
                minifiedPathPrefix: '/static/',
                minifiedUrl: '/static/app.js',
                relativePath: 'app.js',
                sourcemapFilePath: '/build/app.js.map',
            });
            expect(result[1]).toEqual({
                minifiedFilePath: '/build/vendor.js',
                minifiedPathPrefix: '/static/',
                minifiedUrl: '/static/vendor.js',
                relativePath: 'vendor.js',
                sourcemapFilePath: '/build/vendor.js.map',
            });
        });

        test('Should throw error when no output files found', () => {
            const options = getSourcemapsConfiguration();
            const outDir = '/build';
            const outputs: Output[] = [];

            expect(() =>
                getSourcemapsFiles(options, {
                    outDir,
                    outputs,
                }),
            ).toThrow('No output files found.');
        });

        test('Should work with URL-based prefix', () => {
            const options = getSourcemapsConfiguration({
                minifiedPathPrefix: 'https://cdn.example.com/static/',
            });
            const outDir = '/build';
            const outputs: Output[] = [
                {
                    name: 'app.js.map',
                    filepath: '/build/app.js.map',
                    inputs: [],
                    size: 500,
                    type: 'js',
                },
            ];

            const result = getSourcemapsFiles(options, {
                outDir,
                outputs,
            });

            expect(result[0]).toEqual({
                minifiedFilePath: '/build/app.js',
                minifiedPathPrefix: 'https://cdn.example.com/static/',
                minifiedUrl: 'https://cdn.example.com/static/app.js',
                relativePath: 'app.js',
                sourcemapFilePath: '/build/app.js.map',
            });
        });
    });
});
