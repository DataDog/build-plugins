// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { collectAssets } from '@dd/apps-plugin/assets';
import { glob } from 'glob';

jest.mock('glob', () => ({
    glob: jest.fn(),
}));

const globMock = jest.mocked(glob);

describe('Apps Plugin - collectAssets', () => {
    test('Should resolve unique assets with relative paths', async () => {
        globMock.mockResolvedValue([
            '/root/project/dist/app.js',
            '/root/project/dist/app.css',
            '/root/project/public/favicon.ico',
        ]);

        const assets = await collectAssets(['dist/**/*', 'public/**/*'], '/root/project');

        expect(globMock).toHaveBeenCalledTimes(2);
        expect(globMock).toHaveBeenNthCalledWith(1, 'dist/**/*', {
            absolute: true,
            cwd: '/root/project',
            nodir: true,
        });
        expect(globMock).toHaveBeenNthCalledWith(2, 'public/**/*', {
            absolute: true,
            cwd: '/root/project',
            nodir: true,
        });

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
