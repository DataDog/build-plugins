// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import { addFixtureFiles } from '@dd/tests/_jest/helpers/mocks';

jest.mock('@dd/core/helpers/fs', () => {
    const original = jest.requireActual('@dd/core/helpers/fs');
    return {
        ...original,
        existsSync: jest.fn(),
    };
});

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
                description: 'with a single path.',
                directories: ['/path/to'],
                expected: '/path/to',
            },
            {
                description: 'with two paths.',
                directories: ['/path/to', '/path/to/other'],
                expected: '/path/to',
            },
            {
                description: 'with a different root directory.',
                directories: ['/path/to', '/path2/to/other'],
                expected: '/',
            },
            {
                description: 'with an absolute file.',
                directories: ['/path/to', '/'],
                expected: '/',
            },
            {
                description: 'with a given cwd.',
                cwd: '/path',
                directories: ['/path/to', './', '/path/to/other'],
                expected: '/path',
            },
            {
                description: 'with an empty array of paths.',
                directories: [],
                expected: '/',
            },
        ])(
            'Should find the nearest common directory $description',
            async ({ directories, cwd, expected }) => {
                const { getNearestCommonDirectory } = await import('@dd/core/helpers/paths');
                expect(getNearestCommonDirectory(directories, cwd)).toBe(expected);
            },
        );
    });

    describe('getHighestPackageJsonDir', () => {
        beforeEach(() => {
            addFixtureFiles({
                '/path1/to/package.json': '',
                '/path2/to/other/package.json': '',
                '/path3/to/other/deeper/package.json': '',
            });
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

    describe('getClosest', () => {
        beforeEach(() => {
            addFixtureFiles({
                '/path1/to/package.json': '',
                '/path2/to/other/package.json': '',
                '/path3/to/other/deeper/package.json': '',
            });
        });

        test.each([
            ['/path1/to', '/path1/to/package.json'],
            ['/path2/to/other/project/directory', '/path2/to/other/package.json'],
            ['/path3/to/other/deeper/who/knows', '/path3/to/other/deeper/package.json'],
            ['/', undefined],
        ])('Should find the closest package.json', async (dirpath, expected) => {
            const { getClosest, getClosestPackageJson } = await import('@dd/core/helpers/paths');
            expect(getClosestPackageJson(dirpath)).toBe(expected);
            expect(getClosest(dirpath, 'package.json')).toBe(expected);
        });
    });
});
