// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as assets from '@dd/apps-plugin/assets';
import * as identifier from '@dd/apps-plugin/identifier';
import { getVitePlugin } from '@dd/apps-plugin/vite/index';
import type { ViteBundler } from '@dd/apps-plugin/vite/index';
import { InjectPosition } from '@dd/core/types';
import { getContextMock, getRepositoryDataMock, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import { parseAst } from 'rollup/parseAst';

import { encodeQueryName } from '../backend/encodeQueryName';
import type { BackendFunction } from '../backend/types';

type TransformHandler = (code: string, id: string) => unknown;

// Narrows `plugin.transform` to the object-hook form via a runtime check, then wraps `handler` in `Reflect.apply` to match `TransformHandler` without casting its wider real signature.
function getTransformHandler(plugin: ReturnType<typeof getVitePlugin>): TransformHandler {
    const { transform } = plugin ?? {};
    if (
        typeof transform !== 'object' ||
        transform === null ||
        typeof transform.handler !== 'function'
    ) {
        throw new Error(
            'Expected plugin.transform to be the object-hook form with a handler function',
        );
    }

    const handler = transform.handler;
    return function callTransformHandler(this: unknown, code: string, id: string): unknown {
        return Reflect.apply(handler, this, [code, id]);
    };
}

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

const mockViteBuild = jest.fn();
const mockVite = {
    build: mockViteBuild,
    transformWithEsbuild: jest.fn(),
} as unknown as ViteBundler;
const mockInject = jest.fn();

function mockBuildResult() {
    return {
        output: [
            { type: 'chunk', isEntry: true, name: bundleName1, fileName: `${bundleName1}.js` },
            { type: 'chunk', isEntry: true, name: bundleName2, fileName: `${bundleName2}.js` },
        ],
    };
}

function emitModuleParsed(
    config: {
        plugins?: Array<{
            moduleParsed?: (this: { parse: typeof parseAst }, moduleInfo: unknown) => void;
        }>;
    },
    id: string,
    code: string,
) {
    for (const plugin of config.plugins ?? []) {
        plugin.moduleParsed?.call(
            { parse: parseAst },
            {
                id,
                code,
                importedIds: [],
            },
        );
    }
}

function mockBuildWithParsedBackend() {
    mockViteBuild.mockImplementation(async (config) => {
        emitModuleParsed(
            config,
            '/build/src/backend/myHandler.backend.ts',
            `
                export function myHandler() {}
                export function otherFunc() {}
            `,
        );
        return mockBuildResult();
    });
}

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
        authOverrides: {
            method: 'apiKey' as const,
        },
        include: [],
        dryRun: true,
        oauth: {
            authorizationUrl: 'https://api.datadoghq.com/oauth2/v1/authorize',
            cacheTokens: true,
            clientId: 'client-id',
            openBrowser: false,
            redirectUri: 'http://localhost:8060',
            timeoutMs: 1000,
            tokenUrl: 'https://api.datadoghq.com/oauth2/v1/token',
        },
    },
};

describe('Backend Functions - getVitePlugin', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
        mockBuildWithParsedBackend();
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
        const handler = getTransformHandler(plugin);

        await handler.call(
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

    test('Should reject a backend file importing a Node built-in module', () => {
        const plugin = getVitePlugin(defaultOptions);
        const handler = getTransformHandler(plugin);
        const resolveMock = jest.fn(async () => null);
        const loadMock = jest.fn(async () => null);
        const addWatchFileMock = jest.fn();

        expect(() =>
            handler.call(
                {
                    parse: parseAst,
                    resolve: resolveMock,
                    load: loadMock,
                    addWatchFile: addWatchFileMock,
                },
                `
                    import fs from 'node:fs';
                    export function myHandler() {
                        return fs.readFileSync('/etc/passwd', 'utf8');
                    }
                `,
                '/build/src/backend/myHandler.backend.ts',
            ),
        ).toThrow(
            'Importing Node built-in module "node:fs" is not supported in backend function code',
        );
    });

    test('Should warn, but not reject, a backend file referencing crypto or Intl', () => {
        const plugin = getVitePlugin(defaultOptions);
        const handler = getTransformHandler(plugin);
        const resolveMock = jest.fn(async () => null);
        const loadMock = jest.fn(async () => null);
        const addWatchFileMock = jest.fn();

        expect(() =>
            handler.call(
                {
                    parse: parseAst,
                    resolve: resolveMock,
                    load: loadMock,
                    addWatchFile: addWatchFileMock,
                },
                `
                    export function myHandler() {
                        return crypto.randomUUID() + new Intl.NumberFormat('en-US').format(1);
                    }
                `,
                '/build/src/backend/myHandler.backend.ts',
            ),
        ).not.toThrow();

        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('crypto'), 'warn');
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('Intl'), 'warn');
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
