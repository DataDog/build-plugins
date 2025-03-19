// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import { vol } from 'memfs';

// Use mock files.
jest.mock('fs', () => require('memfs').fs);

describe('Core Helpers', () => {
    describe('formatDuration', () => {
        test.each([
            [0, '0ms'],
            [10, '10ms'],
            [10000, '10s'],
            [10010, '10s 10ms'],
            [1000000, '16m 40s'],
            [1000010, '16m 40s 10ms'],
            [10000000, '2h 46m 40s'],
            [10000010, '2h 46m 40s 10ms'],
            [1000000000, '11d 13h 46m 40s'],
            [1000000010, '11d 13h 46m 40s 10ms'],
        ])('Should format duration %s => %s', async (ms, expected) => {
            const { formatDuration } = await import('@dd/core/helpers');
            expect(formatDuration(ms)).toBe(expected);
        });
    });

    describe('truncateString', () => {
        test.each([
            // No truncation needed.
            ['Short string', 20, '[...]', 'Short string'],
            // Keep at least 2 characters on each side.
            ['Short string', 2, '[...]', 'Sh[...]ng'],
            // Equaly truncate on both sides.
            [
                'A way too long sentence could be truncated a bit.',
                20,
                '[...]',
                'A way t[...]d a bit.',
            ],
            // Custom placeholder.
            [
                'A way too long sentence could be truncated a bit.',
                20,
                '***',
                'A way to***ed a bit.',
            ],
            // Longer sentence.
            [
                'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
                50,
                '[...]',
                'Lorem ipsu[...]t ut labore et dolore magna aliqua.',
            ],
        ])(
            'Should truncate string "%s" to max length %d with placeholder "%s" => "%s"',
            async (str, maxLength, placeholder, expected) => {
                const { truncateString } = await import('@dd/core/helpers');
                expect(truncateString(str, maxLength, placeholder)).toBe(expected);
            },
        );
    });

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
            const { getAbsolutePath } = await import('@dd/core/helpers');
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
            const { getNearestCommonDirectory } = await import('@dd/core/helpers');
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
            const { getHighestPackageJsonDir } = await import('@dd/core/helpers');
            expect(getHighestPackageJsonDir(dirpath)).toBe(expected);
        });
    });
});
