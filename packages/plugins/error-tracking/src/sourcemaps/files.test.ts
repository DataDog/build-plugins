// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    joinUrlOrPath,
    decomposePath,
    getSourcemapsFiles,
} from '@dd/error-tracking-plugin/sourcemaps/files';
import {
    getContextMock,
    getMockBuildReport,
    getSourcemapsConfiguration,
} from '@dd/tests/_jest/helpers/mocks';
import stripAnsi from 'strip-ansi';

import type { MinifiedPathPrefix } from '../types';

describe('Error Tracking Plugin Sourcemaps Files', () => {
    describe('joinUrlOrPath', () => {
        const cases = [
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
            {
                description: 'malformed URL with fallback',
                base: 'https:/',
                relativePath: '/app.js',
                expected: 'https:/app.js',
            },
        ];

        test.each(cases)('Should handle $description', ({ base, relativePath, expected }) => {
            expect(joinUrlOrPath(base, relativePath)).toBe(expected);
        });
    });

    describe('decomposePath', () => {
        const cases: Array<{
            description: string;
            outDir: string;
            minifiedPathPrefix: MinifiedPathPrefix;
            sourcemapFilePath: string;
            expectedMinifiedFilePath: string;
            expectedRelativePath: string;
            expectedMinifiedUrl: string;
        }> = [
            {
                description: 'file in root of outDir',
                outDir: '/build/dist',
                minifiedPathPrefix: '/static/',
                sourcemapFilePath: '/build/dist/app.js.map',
                expectedMinifiedFilePath: '/build/dist/app.js',
                expectedRelativePath: 'app.js',
                expectedMinifiedUrl: '/static/app.js',
            },
            {
                description: 'file in subdirectory',
                outDir: '/project/output',
                minifiedPathPrefix: '/static/',
                sourcemapFilePath: '/project/output/assets/main.js.map',
                expectedMinifiedFilePath: '/project/output/assets/main.js',
                expectedRelativePath: 'assets/main.js',
                expectedMinifiedUrl: '/static/assets/main.js',
            },
            {
                description: 'complex nested path',
                outDir: '/home/user/build/assets',
                minifiedPathPrefix: '/static/',
                sourcemapFilePath: '/home/user/build/assets/components/Button.js.map',
                expectedMinifiedFilePath: '/home/user/build/assets/components/Button.js',
                expectedRelativePath: 'components/Button.js',
                expectedMinifiedUrl: '/static/components/Button.js',
            },
            {
                description: 'URL minified prefix',
                outDir: '/build',
                minifiedPathPrefix: 'https://cdn.example.com/static/',
                sourcemapFilePath: '/build/app.js.map',
                expectedMinifiedFilePath: '/build/app.js',
                expectedRelativePath: 'app.js',
                expectedMinifiedUrl: 'https://cdn.example.com/static/app.js',
            },
        ];

        test.each(cases)(
            'Should decompose $description',
            ({
                outDir,
                minifiedPathPrefix,
                sourcemapFilePath,
                expectedMinifiedFilePath,
                expectedRelativePath,
                expectedMinifiedUrl,
            }) => {
                const mockOptions = getSourcemapsConfiguration({ minifiedPathPrefix });
                const context = getContextMock({
                    bundler: { name: 'esbuild', fullName: 'esbuild', outDir, version: '1.0.0' },
                });

                const result = decomposePath(mockOptions, context, sourcemapFilePath);

                expect(result).toEqual({
                    minifiedFilePath: expectedMinifiedFilePath,
                    relativePath: expectedRelativePath,
                    minifiedUrl: expectedMinifiedUrl,
                });
            },
        );

        test('Should throw error for non-sourcemap files', () => {
            const mockOptions = getSourcemapsConfiguration({ minifiedPathPrefix: '/static/' });
            const context = getContextMock({
                bundler: {
                    name: 'esbuild',
                    fullName: 'esbuild',
                    outDir: '/build',
                    version: '1.0.0',
                },
            });

            try {
                decomposePath(mockOptions, context, '/build/app.js');
                fail('Expected error to be thrown');
            } catch (error: any) {
                expect(stripAnsi(error.message)).toBe('The file /build/app.js is not a sourcemap.');
            }
        });
    });

    describe('getSourcemapsFiles', () => {
        test('Should process multiple sourcemap files', () => {
            const options = getSourcemapsConfiguration({ minifiedPathPrefix: '/static/' });
            const context = getContextMock({
                bundler: {
                    name: 'esbuild',
                    fullName: 'esbuild',
                    outDir: '/build',
                    version: '1.0.0',
                },
                build: {
                    ...getMockBuildReport(),
                    outputs: [
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
                    ],
                },
            });

            const result = getSourcemapsFiles(options, context);

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
            const context = getContextMock({
                bundler: {
                    name: 'esbuild',
                    fullName: 'esbuild',
                    outDir: '/build',
                    version: '1.0.0',
                },
                build: { ...getMockBuildReport(), outputs: [] },
            });

            expect(() => getSourcemapsFiles(options, context)).toThrow('No output files found.');
        });

        test('Should work with URL-based prefix', () => {
            const options = getSourcemapsConfiguration({
                minifiedPathPrefix: 'https://cdn.example.com/static/',
            });
            const context = getContextMock({
                bundler: {
                    name: 'esbuild',
                    fullName: 'esbuild',
                    outDir: '/build',
                    version: '1.0.0',
                },
                build: {
                    ...getMockBuildReport(),
                    outputs: [
                        {
                            name: 'app.js.map',
                            filepath: '/build/app.js.map',
                            inputs: [],
                            size: 500,
                            type: 'js',
                        },
                    ],
                },
            });

            const result = getSourcemapsFiles(options, context);

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
