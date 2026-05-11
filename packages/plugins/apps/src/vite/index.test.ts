// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as assets from '@dd/apps-plugin/assets';
import * as identifier from '@dd/apps-plugin/identifier';
import { getVitePlugin } from '@dd/apps-plugin/vite/index';
import type { ViteBundler } from '@dd/apps-plugin/vite/index';
import { InjectPosition } from '@dd/core/types';
import { getContextMock, getRepositoryDataMock } from '@dd/tests/_jest/helpers/mocks';
import { parseAst } from 'rollup/parseAst';

import { encodeQueryName } from '../backend/encodeQueryName';
import type { BackendFunction } from '../backend/types';

const functions: BackendFunction[] = [
    {
        relativePath: 'src/backend/myHandler',
        name: 'myHandler',
        absolutePath: '/src/backend/myHandler.backend.ts',
        allowedConnectionIds: [],
    },
    {
        relativePath: 'src/backend/otherFunc',
        name: 'otherFunc',
        absolutePath: '/src/backend/otherFunc.backend.ts',
        allowedConnectionIds: [],
    },
];

const bundleName1 = encodeQueryName(functions[0]);
const bundleName2 = encodeQueryName(functions[1]);

const mockViteBuild = jest.fn().mockResolvedValue({
    output: [
        { type: 'chunk', isEntry: true, name: bundleName1, fileName: `${bundleName1}.js` },
        { type: 'chunk', isEntry: true, name: bundleName2, fileName: `${bundleName2}.js` },
    ],
});
const mockVite = {
    build: mockViteBuild,
    transformWithEsbuild: jest.fn(),
} as unknown as ViteBundler;
const mockInject = jest.fn();

const defaultOptions = {
    bundler: mockVite,
    context: getContextMock({
        buildRoot: '/build',
        bundler: {
            name: 'vite',
            version: 'FAKE_VERSION',
            outDir: '/build/dist',
        },
        git: getRepositoryDataMock({ remote: 'git@github.com:org/repo.git' }),
        inject: mockInject,
        version: 'FAKE_VERSION',
    }),
    options: {
        enable: true,
        include: [],
        dryRun: true,
    },
};

describe('Backend Functions - getVitePlugin', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        mockViteBuild.mockClear();
        mockInject.mockClear();
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
        jest.spyOn(assets, 'collectAssets').mockResolvedValue([]);
    });

    test('Should return a vite plugin object with closeBundle', () => {
        const plugin = getVitePlugin(defaultOptions);
        expect(plugin).toBeDefined();
        expect(plugin!.transform).toEqual(expect.any(Object));
        expect(plugin!.closeBundle).toEqual(expect.any(Function));
    });

    test('Should build backend functions and then upload in closeBundle', async () => {
        const plugin = getVitePlugin(defaultOptions);
        const transform = plugin!.transform as {
            handler: (code: string, id: string) => unknown;
        };

        await transform.handler.call(
            {
                parse: parseAst,
                resolve: jest.fn(async () => null),
                load: jest.fn(async () => null),
                addWatchFile: jest.fn(),
            },
            `
                export function myHandler() {}
                export function otherFunc() {}
            `,
            '/build/src/backend/myHandler.backend.ts',
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (plugin as any).closeBundle();

        expect(mockViteBuild).toHaveBeenCalledTimes(2);
        expect(assets.collectAssets).toHaveBeenCalledWith(['dist/**/*'], '/build');
    });

    test('Should inject the apps runtime', () => {
        getVitePlugin(defaultOptions);

        expect(mockInject).toHaveBeenCalledWith({
            type: 'file',
            position: InjectPosition.MIDDLE,
            value: expect.stringMatching(/[/\\]apps-runtime\.mjs$/),
        });
    });
});
