// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { collectAssets, findCommonPrefix } from '@dd/apps-plugin/assets';
import { glob } from 'glob';
import path from 'path';

jest.mock('glob', () => ({
    glob: jest.fn(),
}));

const globMock = jest.mocked(glob);

describe('Apps Plugin - findCommonPrefix', () => {
    const cases = [
        {
            description: 'return empty string for empty array',
            input: [],
            expected: '',
        },
        {
            description: 'return common directory for paths with same prefix',
            input: ['dist/app.js', 'dist/app.css', 'dist/assets/logo.png'],
            expected: 'dist',
        },
        {
            description: 'return nested common directory',
            input: [
                'dist/assets/js/app.js',
                'dist/assets/js/vendor.js',
                'dist/assets/css/style.css',
            ],
            expected: path.join('dist', 'assets'),
        },
        {
            description: 'return empty string when no common directory',
            input: ['dist/app.js', 'public/favicon.ico'],
            expected: '',
        },
        {
            description: 'return empty string for single level paths',
            input: ['app.js', 'style.css'],
            expected: '',
        },
        {
            description: 'handle single file',
            input: ['dist/app.js'],
            expected: 'dist',
        },
        {
            description: 'find deepest common prefix',
            input: ['a/b/c/file1.js', 'a/b/c/file2.js', 'a/b/c/d/file3.js'],
            expected: path.join('a', 'b', 'c'),
        },
    ];

    test.each(cases)('Should $description', ({ input, expected }) => {
        expect(findCommonPrefix(input)).toBe(expected);
    });
});

describe('Apps Plugin - collectAssets', () => {
    test('Should resolve unique assets with relative paths stripped of common prefix', async () => {
        globMock.mockResolvedValue([
            '/root/project/dist/app.js',
            '/root/project/dist/app.css',
            '/root/project/dist/assets/logo.png',
        ]);

        const assets = await collectAssets(['dist/**/*'], '/root/project');

        expect(globMock).toHaveBeenCalledTimes(1);
        expect(globMock).toHaveBeenNthCalledWith(1, 'dist/**/*', {
            absolute: true,
            cwd: '/root/project',
            nodir: true,
        });

        expect(assets).toEqual([
            {
                absolutePath: '/root/project/dist/app.js',
                relativePath: 'app.js',
            },
            {
                absolutePath: '/root/project/dist/app.css',
                relativePath: 'app.css',
            },
            {
                absolutePath: '/root/project/dist/assets/logo.png',
                relativePath: path.join('assets', 'logo.png'),
            },
        ]);
    });

    test('Should handle multiple patterns without common prefix', async () => {
        globMock.mockResolvedValueOnce(['/root/project/dist/app.js', '/root/project/dist/app.css']);
        globMock.mockResolvedValueOnce(['/root/project/public/favicon.ico']);

        const assets = await collectAssets(['dist/**/*', 'public/**/*'], '/root/project');

        expect(globMock).toHaveBeenCalledTimes(2);

        // When there's no common prefix, paths should remain as-is
        expect(assets).toEqual([
            {
                absolutePath: '/root/project/dist/app.js',
                relativePath: 'dist/app.js',
            },
            {
                absolutePath: '/root/project/dist/app.css',
                relativePath: 'dist/app.css',
            },
            {
                absolutePath: '/root/project/public/favicon.ico',
                relativePath: 'public/favicon.ico',
            },
        ]);
    });

    test('Should return an empty list when nothing matches', async () => {
        globMock.mockResolvedValue([]);

        const assets = await collectAssets(['dist/**/*'], '/root/project');

        expect(assets).toEqual([]);
    });
});
