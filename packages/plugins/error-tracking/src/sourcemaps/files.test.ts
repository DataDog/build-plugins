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

describe('Error Tracking Plugin Sourcemaps Files', () => {
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
                // Should start with "minified/" and end with ".min.js" or ".min.mjs".
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
