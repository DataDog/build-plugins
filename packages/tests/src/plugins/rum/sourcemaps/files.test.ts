// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getSourcemapsFiles } from '@dd/rum-plugins/sourcemaps/files';
import { vol } from 'memfs';
import path from 'path';

import { getSourcemapsConfiguration } from '../testHelpers';

jest.mock('fs', () => require('memfs').fs);

describe('RUM Plugin Sourcemaps Files', () => {
    beforeEach(() => {
        // Emulate some fixtures.
        vol.fromJSON(
            {
                // Adding three files outside the basePath that should not be matched.
                'common.js': '',
                'common.min.js.map': '',
                'common.min.js': '',
                // Adding both .js and .mjs files.
                'fixtures/common.js': '',
                'fixtures/common.min.js.map': '',
                'fixtures/common.min.js': '',
                'fixtures/common.mjs': '',
                'fixtures/common.min.mjs': '',
                'fixtures/common.min.mjs.map': '',
            },
            __dirname,
        );
    });

    afterEach(() => {
        vol.reset();
    });

    test('It should get sourcemap files.', async () => {
        const sourcemaps = getSourcemapsFiles(
            getSourcemapsConfiguration({
                basePath: path.resolve(__dirname, 'fixtures'),
                minifiedPathPrefix: '/minified',
            }),
        );
        expect(sourcemaps.length).toBe(2);

        for (const sourcemap of sourcemaps) {
            expect(sourcemap).toMatchObject({
                // Should end with ".min.js" or ".min.mjs".
                minifiedFilePath: expect.stringMatching(/\.min\.(js|mjs)$/),
                // Should start with "minified/" and end with ".min.js" or ".min.mjs".
                minifiedUrl: expect.stringMatching(/^\/minified\/.*\.min\.(js|mjs)$/),
                // Should start with "/" and end with ".min.js" or ".min.mjs".
                relativePath: expect.stringMatching(/^\/.*\.min\.(js|mjs)$/),
                // Should end with ".map".
                sourcemapFilePath: expect.stringMatching(/\.map$/),
                minifiedPathPrefix: '/minified',
            });
        }
    });
});
