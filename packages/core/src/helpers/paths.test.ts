// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import { vol } from 'memfs';

// Use mock files.
jest.mock('fs', () => require('memfs').fs);

describe('Core Helpers', () => {
    describe('getAbsolutePath', () => {
        test.each([
            // With the injection file.
            ['/path/to', `./to/1293.${INJECTED_FILE}.js`, INJECTED_FILE],
            // With a path with no prefix.
            ['/path/to', 'file.js', '/path/to/file.js'],
            // With a path with a dot prefix.
            ['/path/to', './file.js', '/path/to/file.js'],
            ['/path/to', '../file.js', '/path/file.js'],
            ['/path/to', '../../file.js', '/file.js'],
            ['/path/to', '../../../file.js', '/file.js'],
            // With an absolute path.
            ['/path/to', '/file.js', '/file.js'],
        ])('Should resolve "%s" with "%s" to "%s"', async (base, relative, expected) => {
            const { getAbsolutePath } = await import('@dd/core/helpers/paths');
            expect(getAbsolutePath(base, relative)).toBe(expected);
        });
    });

    describe('getNearestCommonDirectory', () => {
        test.each([
            {
                // With a single path.
                directories: ['/path/to'],
                expected: '/path/to',
            },
            {
                // Basic usage.
                directories: ['/path/to', '/path/to/other'],
                expected: '/path/to',
            },
            {
                // With a different root directory.
                directories: ['/path/to', '/path2/to/other'],
                expected: '/',
            },
            {
                // With an absolute file.
                directories: ['/path/to', '/'],
                expected: '/',
            },
            {
                // With a given cwd.
                cwd: '/path',
                directories: ['/path/to', './', '/path/to/other'],
                expected: '/path',
            },
        ])('Should find the nearest common directory', async ({ directories, cwd, expected }) => {
            const { getNearestCommonDirectory } = await import('@dd/core/helpers/paths');
            expect(getNearestCommonDirectory(directories, cwd)).toBe(expected);
        });
    });

    describe('getHighestPackageJsonDir', () => {
        beforeEach(() => {
            vol.fromJSON({
                '/path1/to/package.json': '',
                '/path2/to/other/package.json': '',
                '/path3/to/other/deeper/package.json': '',
            });
        });

        afterEach(() => {
            vol.reset();
        });

        test.each([
            ['/path1/to', '/path1/to'],
            ['/path2/to/other/project/directory', '/path2/to/other'],
            ['/path3/to/other/deeper/who/knows', '/path3/to/other/deeper'],
            ['/', undefined],
        ])('Should find the highest package.json', async (dirpath, expected) => {
            const { getHighestPackageJsonDir } = await import('@dd/core/helpers/paths');
            expect(getHighestPackageJsonDir(dirpath)).toBe(expected);
        });
    });

    describe('getClosestPackageJson', () => {
        beforeEach(() => {
            vol.fromJSON({
                '/path1/to/package.json': '',
                '/path2/to/other/package.json': '',
                '/path3/to/other/deeper/package.json': '',
            });
        });

        afterEach(() => {
            vol.reset();
        });

        test.each([
            ['/path1/to', '/path1/to/package.json'],
            ['/path2/to/other/project/directory', '/path2/to/other/package.json'],
            ['/path3/to/other/deeper/who/knows', '/path3/to/other/deeper/package.json'],
            ['/', undefined],
        ])('Should find the closest package.json', async (dirpath, expected) => {
            const { getClosestPackageJson } = await import('@dd/core/helpers/paths');
            expect(getClosestPackageJson(dirpath)).toBe(expected);
        });
    });
});
