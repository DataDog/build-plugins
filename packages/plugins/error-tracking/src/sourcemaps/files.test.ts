// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getSourcemapsFiles } from '@dd/error-tracking-plugin/sourcemaps/files';
import {
    getContextMock,
    getMockBuildReport,
    getSourcemapsConfiguration,
} from '@dd/tests/_jest/helpers/mocks';
import path from 'path';

import type { MinifiedPathPrefix } from '../types';

describe('Error Tracking Plugin Sourcemaps Files', () => {
    const testCases: Array<{
        description: string;
        outDir: string;
        filePath: string;
        minifiedPathPrefix: MinifiedPathPrefix;
        expectedRelativePath: string;
        expectedMinifiedUrl: string;
    }> = [
        {
            description: 'simple file in root of outDir',
            outDir: '/build/dist',
            filePath: '/build/dist/app.js.map',
            minifiedPathPrefix: '/static/',
            expectedRelativePath: '/app.js',
            expectedMinifiedUrl: '/static/app.js',
        },
        {
            description: 'file in subdirectory',
            outDir: '/project/output',
            filePath: '/project/output/assets/main.js.map',
            minifiedPathPrefix: '/static/',
            expectedRelativePath: '/assets/main.js',
            expectedMinifiedUrl: '/static/assets/main.js',
        },
        {
            description: 'complex nested path',
            outDir: '/home/user/build/assets',
            filePath: '/home/user/build/assets/components/Button.js.map',
            minifiedPathPrefix: '/assets',
            expectedRelativePath: '/components/Button.js',
            expectedMinifiedUrl: '/assets/components/Button.js',
        },
    ];

    test.each(testCases)(
        'Should correctly compute paths for $description',
        async ({
            minifiedPathPrefix,
            outDir,
            filePath,
            expectedRelativePath,
            expectedMinifiedUrl,
        }) => {
            const sourcemaps = getSourcemapsFiles(
                getSourcemapsConfiguration({
                    minifiedPathPrefix,
                }),
                getContextMock({
                    bundler: {
                        name: 'esbuild',
                        fullName: 'esbuild',
                        outDir,
                        version: '1.0.0',
                    },
                    build: {
                        ...getMockBuildReport(),
                        outputs: [
                            {
                                name: path.basename(filePath),
                                filepath: filePath,
                                inputs: [],
                                size: 1000,
                                type: 'js',
                            },
                        ],
                    },
                }),
            );

            expect(sourcemaps.length).toBe(1);
            const sourcemap = sourcemaps[0];

            expect(sourcemap.relativePath).toBe(expectedRelativePath);
            expect(sourcemap.minifiedUrl).toBe(expectedMinifiedUrl);
        },
    );

    test('Should get sourcemap files.', async () => {
        const sourcemaps = getSourcemapsFiles(
            getSourcemapsConfiguration({
                minifiedPathPrefix: '/minified',
            }),
            getContextMock({
                bundler: {
                    name: 'esbuild',
                    fullName: 'esbuild',
                    outDir: __dirname,
                    version: '1.0.0',
                },
                build: {
                    ...getMockBuildReport(),
                    outputs: [
                        'fixtures/common.js',
                        'fixtures/common.min.js.map',
                        'fixtures/common.min.js',
                        'fixtures/common.mjs',
                        'fixtures/common.min.mjs',
                        'fixtures/common.min.mjs.map',
                    ].map((filepath) => ({
                        name: path.basename(filepath),
                        filepath: path.join(__dirname, filepath),
                        inputs: [],
                        size: 0,
                        type: 'js',
                    })),
                },
            }),
        );

        expect(sourcemaps.length).toBe(2);

        for (const sourcemap of sourcemaps) {
            expect(sourcemap).toMatchObject({
                // Should end with ".min.js" or ".min.mjs".
                minifiedFilePath: expect.stringMatching(/\.min\.(js|mjs)$/),
                // Should start with "/minified/" and end with ".min.js" or ".min.mjs".
                minifiedUrl: expect.stringMatching(/^\/minified\/fixtures\/common\.min\.(js|mjs)$/),
                // Should start with "/" and end with ".min.js" or ".min.mjs".
                relativePath: expect.stringMatching(/^\/fixtures\/common\.min\.(js|mjs)$/),
                // Should end with ".map".
                sourcemapFilePath: expect.stringMatching(/\.map$/),
                minifiedPathPrefix: '/minified',
            });
        }
    });
});
