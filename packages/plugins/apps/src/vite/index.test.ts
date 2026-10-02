// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getVitePlugin } from '@dd/apps-plugin/vite/index';
import type { ViteBundler } from '@dd/apps-plugin/vite/index';
import { localExecutionResolutionContext } from '@dd/apps-plugin/vite/local-execution';
import { InjectPosition } from '@dd/core/types';
import { cleanEnv } from '@dd/tests/_jest/helpers/env';
import {
    createMockRequest,
    createMockResponse,
    getContextMock,
    getRepositoryDataMock,
    mockLogFn,
} from '@dd/tests/_jest/helpers/mocks';
import type { IncomingMessage, ServerResponse } from 'http';
import nock from 'nock';
import path from 'path';
import { parseAst } from 'rollup/parseAst';
import type { PluginContext } from 'rollup';
import { createUnplugin } from 'unplugin';
import { createServer, type Plugin as VitePlugin, type ViteDevServer } from 'vite';

import * as auth from '../auth';
import { encodeQueryName } from '../backend/encodeQueryName';
import type { BackendFunction } from '../backend/types';
import {
    BACKEND_FILE_WITH_QUERY_RE,
    DEV_VERIFY_MODE,
    LOCAL_EXECUTION_LOAD_SUFFIX,
} from '../constants';

import * as buildPackage from './build-package';

type TransformHandler = (code: string, id: string, transformOptions?: { ssr?: boolean }) => unknown;

// Narrows `plugin.transform` to the object-hook form via a runtime check, since tests need to access both `handler` and `filter` without an `as` cast.
function getTransformObject(plugin: ReturnType<typeof getVitePlugin>) {
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
    return transform;
}

// Wraps `handler` in `Reflect.apply` to match `TransformHandler` without casting its wider real signature.
function getTransformHandler(plugin: ReturnType<typeof getVitePlugin>): TransformHandler {
    const { handler } = getTransformObject(plugin);
    return function callTransformHandler(
        this: unknown,
        code: string,
        id: string,
        transformOptions?: { ssr?: boolean },
    ): unknown {
        return Reflect.apply(handler, this, [code, id, transformOptions]);
    };
}

/** Extracts `.code` from a transform hook's result if it's the object form — avoids an `as` cast on the otherwise-broad Rollup `TransformResult` union, since these tests only ever care about the code string. */
function extractTransformedCode(result: unknown): string | undefined {
    return typeof result === 'object' &&
        result !== null &&
        'code' in result &&
        typeof result.code === 'string'
        ? result.code
        : undefined;
}

type DevServerMiddleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

// The subset of Vite's real `ViteDevServer` this test's fake server object provides.
type FakeViteDevServer = {
    middlewares: { use: (fn: DevServerMiddleware) => void };
    ssrLoadModule: (id: string) => Promise<unknown>;
    config: { mode: string };
};

// Narrows `plugin.configureServer` to its plain-function hook form via a runtime check, then wraps
// it in a signature scoped to the fake server this test passes, since the real hook's `ViteDevServer`
// parameter is far wider than what these tests construct — mirrors `getTransformHandler` above.
function getConfigureServer(
    plugin: ReturnType<typeof getVitePlugin>,
): (server: FakeViteDevServer) => void {
    const { configureServer } = plugin ?? {};
    if (typeof configureServer !== 'function') {
        throw new Error('Expected plugin.configureServer to be the plain function-hook form');
    }
    return function callConfigureServer(server: FakeViteDevServer): void {
        Reflect.apply(configureServer, undefined, [server]);
    };
}

function isDevServerMiddleware(value: unknown): value is DevServerMiddleware {
    return typeof value === 'function';
}

type ConfigHookResult = {
    ssr: { noExternal: string[] };
};

// Narrows `plugin.config` to its plain-function hook form via a runtime check, avoiding an `as`
// cast on its return value — mirrors `getConfigureServer` above.
function getConfigHandler(plugin: ReturnType<typeof getVitePlugin>): () => ConfigHookResult {
    const { config } = plugin ?? {};
    if (typeof config !== 'function') {
        throw new Error('Expected plugin.config to be the plain function-hook form');
    }
    return function callConfig(): ConfigHookResult {
        return Reflect.apply(config, undefined, []);
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

/** Narrows a Vite plugin's `resolveId` hook to its full-object form (`{ handler, ... }`) so tests can call it directly. */
function getResolveIdHandler(plugin: ReturnType<typeof getVitePlugin>): Function {
    const resolveId = plugin?.resolveId;
    if (
        typeof resolveId !== 'object' ||
        resolveId === null ||
        !('handler' in resolveId) ||
        typeof resolveId.handler !== 'function'
    ) {
        throw new Error('Expected plugin.resolveId to be an object with a handler function.');
    }
    return resolveId.handler;
}

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

const DD_API_ORIGIN = 'https://api.datadoghq.com';

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
        backend: { minify: true },
        longPolling: {
            maxRetries: 10,
            timeoutMs: 40000,
            jitter: true,
            exponentialBackoff: true,
        },
    },
};

describe('Backend Functions - getVitePlugin', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
        mockBuildWithParsedBackend();
        jest.spyOn(buildPackage, 'buildAppPackage').mockResolvedValue(undefined);
    });

    afterEach(() => {
        nock.cleanAll();
    });

    test('Should return a vite plugin object with closeBundle', () => {
        const plugin = getVitePlugin(defaultOptions);
        expect(plugin).toBeDefined();
        expect(plugin!.transform).toEqual(expect.any(Object));
        expect(plugin!.closeBundle).toEqual(expect.any(Function));
    });

    test('Should build backend functions and then package in closeBundle', async () => {
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
        expect(buildPackage.buildAppPackage).toHaveBeenCalledWith(
            expect.objectContaining({
                backendOutputs: expect.any(Map),
                backendFunctions: expect.any(Array),
            }),
        );
    });

    test('skips packaging in closeBundle after a dev server session started', async () => {
        const plugin = getVitePlugin(defaultOptions);
        if (!plugin || Array.isArray(plugin)) {
            throw new Error('Expected getVitePlugin to return a single Vite plugin');
        }
        if (
            typeof plugin.closeBundle !== 'function' ||
            typeof plugin.configureServer !== 'function'
        ) {
            throw new Error('Expected closeBundle and configureServer hooks on the plugin');
        }

        // Only middleware registration is exercised here; a full ViteDevServer
        // is not needed, so cast a minimal stand-in at this library boundary.
        const server = {
            middlewares: { use: jest.fn() },
            ssrLoadModule: jest.fn(),
            config: { mode: 'development' },
        } as unknown as ViteDevServer;
        // The hooks are typed with Rollup's `this: PluginContext`, but the
        // plugin closures never read `this`, so a stand-in satisfies the call.
        const thisArg = {} as unknown as PluginContext;

        // Vite 6 calls closeBundle when a dev server's plugin container closes;
        // starting the dev server must prevent that from packaging.
        plugin.configureServer(server);
        await plugin.closeBundle.call(thisArg);

        expect(mockViteBuild).not.toHaveBeenCalled();
        expect(buildPackage.buildAppPackage).not.toHaveBeenCalled();
    });

    // Regression test: this warning previously lived in createDevServerMiddleware itself: moved
    // here since configureServer is where auth is actually resolved (or fails to be).
    test('Should warn that both executeAction endpoints will be unavailable when no auth is configured', () => {
        const plugin = getVitePlugin(defaultOptions);
        if (!plugin || Array.isArray(plugin)) {
            throw new Error('Expected getVitePlugin to return a single Vite plugin');
        }
        if (typeof plugin.configureServer !== 'function') {
            throw new Error('Expected a configureServer hook on the plugin');
        }

        const server = {
            middlewares: { use: jest.fn() },
            ssrLoadModule: jest.fn(),
            config: { mode: 'development' },
        } as unknown as ViteDevServer;

        plugin.configureServer(server);

        expect(mockLogFn).toHaveBeenCalledWith(
            expect.stringContaining(
                'Both the /__dd/executeAction and /__dd/executeActionViaCloud endpoints will be unavailable',
            ),
            'warn',
        );
    });

    // Regression: the negative case for the warning test above, previously covered by
    // dev-server.test.ts's own deleted 'startup auth warning' describe block.
    test('Should not warn about missing authentication when it is configured', () => {
        jest.spyOn(auth, 'getAuthenticatedRequest').mockReturnValue(jest.fn());
        const plugin = getVitePlugin(defaultOptions);
        if (!plugin || Array.isArray(plugin)) {
            throw new Error('Expected getVitePlugin to return a single Vite plugin');
        }
        if (typeof plugin.configureServer !== 'function') {
            throw new Error('Expected a configureServer hook on the plugin');
        }

        const server = {
            middlewares: { use: jest.fn() },
            ssrLoadModule: jest.fn(),
            config: { mode: 'development' },
        } as unknown as ViteDevServer;

        plugin.configureServer(server);

        expect(mockLogFn).not.toHaveBeenCalledWith(
            expect.stringContaining('No authentication configured'),
            'warn',
        );
    });

    test('does not resolve authentication during production packaging', async () => {
        const authSpy = jest.spyOn(auth, 'getAuthenticatedRequest');
        const plugin = getVitePlugin(defaultOptions);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (plugin as any).closeBundle();

        expect(authSpy).not.toHaveBeenCalled();
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

    // Regression test: without the suffix check, ssrLoadModule() would get the proxy stub instead of the real function body.
    test('Should skip proxy generation for a suffixed local-execution load made from SSR context, returning the real source untouched', async () => {
        const plugin = getVitePlugin(defaultOptions);
        const handler = getTransformHandler(plugin);

        const realSource = 'export function myHandler() { return 42; }';
        const result = await handler.call(
            {
                parse: parseAst,
                resolve: jest.fn(async () => null),
                load: jest.fn(async () => null),
                addWatchFile: jest.fn(),
            },
            realSource,
            `/build/src/backend/myHandler.backend.ts${LOCAL_EXECUTION_LOAD_SUFFIX}`,
            { ssr: true },
        );

        expect(result).toBeNull();
    });

    // Regression test: the suffix alone must not bypass proxy generation — a spoofed client-side import reusing it still gets the safe proxy stub, never the real backend module body.
    test('Should still generate the frontend RPC-proxy for a suffixed import made outside SSR context', async () => {
        const plugin = getVitePlugin(defaultOptions);
        const transformHandler = getTransformHandler(plugin);

        const result = await transformHandler.call(
            {
                parse: parseAst,
                resolve: jest.fn(async () => null),
                load: jest.fn(async () => null),
                addWatchFile: jest.fn(),
            },
            'export function myHandler() { return 42; }',
            `/build/src/backend/myHandler.backend.ts${LOCAL_EXECUTION_LOAD_SUFFIX}`,
        );

        expect(extractTransformedCode(result)).toEqual(
            expect.stringContaining('executeBackendFunction'),
        );
    });

    test('Should still generate the frontend RPC-proxy for a normal (unsuffixed) import of the same file', async () => {
        const plugin = getVitePlugin(defaultOptions);
        const handler = getTransformHandler(plugin);

        const result = await handler.call(
            {
                parse: parseAst,
                resolve: jest.fn(async () => null),
                load: jest.fn(async () => null),
                addWatchFile: jest.fn(),
            },
            'export function myHandler() { return 42; }',
            '/build/src/backend/myHandler.backend.ts',
        );

        expect(extractTransformedCode(result)).toEqual(
            expect.stringContaining('executeBackendFunction'),
        );
    });

    // Regression test: an unrecognized query string must still be caught by the transform filter, or Vite falls back to its default loader and leaks the real backend source.
    test('Transform filter should match a backend file carrying an unrecognized query string', () => {
        const plugin = getVitePlugin(defaultOptions);
        const { filter } = getTransformObject(plugin);
        const filterId = filter?.id;
        // This plugin always configures `filter.id` as `{ include: RegExp[] }` (see vite/index.ts) —
        // narrowed here rather than asserted, since Rollup's own StringFilter type also allows a bare
        // string/RegExp/array for other plugins' use.
        const includePatterns =
            typeof filterId === 'object' &&
            filterId !== null &&
            !Array.isArray(filterId) &&
            !(filterId instanceof RegExp)
                ? (Array.isArray(filterId.include)
                      ? filterId.include
                      : filterId.include
                        ? [filterId.include]
                        : []
                  ).filter((pattern): pattern is RegExp => pattern instanceof RegExp)
                : [];

        const idsThatMustMatch = [
            '/build/src/backend/myHandler.backend.ts',
            `/build/src/backend/myHandler.backend.ts${LOCAL_EXECUTION_LOAD_SUFFIX}`,
            '/build/src/backend/myHandler.backend.ts?x',
            `/build/src/backend/myHandler.backend.ts${LOCAL_EXECUTION_LOAD_SUFFIX}&x`,
        ];

        for (const id of idsThatMustMatch) {
            expect(includePatterns.some((pattern) => pattern.test(id))).toBe(true);
        }
    });

    // Regression test: an unrecognized query must still default to the safe proxy stub, not the real backend source.
    test('Should still generate the frontend RPC-proxy for an import with an unrecognized query string', async () => {
        const plugin = getVitePlugin(defaultOptions);
        const transformHandler = getTransformHandler(plugin);

        const result = await transformHandler.call(
            {
                parse: parseAst,
                resolve: jest.fn(async () => null),
                load: jest.fn(async () => null),
                addWatchFile: jest.fn(),
            },
            'export function myHandler() { return 42; }',
            '/build/src/backend/myHandler.backend.ts?x',
        );

        expect(extractTransformedCode(result)).toEqual(
            expect.stringContaining('executeBackendFunction'),
        );
    });

    // Regression test: a query-bearing id with zero exports must not clear a DIFFERENT,
    // already-registered import of the same file's real (unsuffixed) id — otherwise one
    // unrelated query-bearing import anywhere in the app permanently breaks the file's real
    // registration until an edit or server restart. Vite's own `?raw`/`?url`/`?worker` load hooks
    // all produce a default export, which is already rejected with a loud throw before this
    // branch is reached — this covers whatever else might legitimately produce zero exports
    // without throwing.
    test('Should not clear an already-registered function when a query-bearing import of the same file has zero exports', async () => {
        const plugin = getVitePlugin(defaultOptions);
        const handler = getTransformHandler(plugin);

        // Real, unsuffixed import — registers myHandler normally.
        await handler.call(
            {
                parse: parseAst,
                resolve: jest.fn(async () => null),
                load: jest.fn(async () => null),
                addWatchFile: jest.fn(),
            },
            'export function myHandler() { return 42; }',
            '/build/src/backend/myHandler.backend.ts',
        );

        // A query-bearing import of the same file with zero exports, not `export default` —
        // Vite's own `?raw`/`?url`/`?worker` hooks produce a default export, already rejected
        // elsewhere, so this covers whatever else could legitimately have no named exports.
        await handler.call(
            {
                parse: parseAst,
                resolve: jest.fn(async () => null),
                load: jest.fn(async () => null),
                addWatchFile: jest.fn(),
            },
            '',
            '/build/src/backend/myHandler.backend.ts?some-other-query',
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (plugin as any).closeBundle();

        // Still built once for myHandler — the ?raw import didn't clear its real registration.
        expect(mockViteBuild).toHaveBeenCalledTimes(1);
    });

    describe('transform on Vite versions without native hook filter support (< 6.3)', () => {
        const transformContext = {
            parse: parseAst,
            resolve: jest.fn(async () => null),
            load: jest.fn(async () => null),
            addWatchFile: jest.fn(),
        };
        const backendCode = 'export function backendFn() { return 1; }';
        const backendId = '/build/src/backend/myHandler.backend.ts';
        const vitePackageJsonPath = require.resolve('vite/package.json');
        const nodeModulesPackageDirectory = path.dirname(vitePackageJsonPath);

        type TransformCase = {
            description: string;
            id: string;
            expected: 'proxied' | 'untouched';
            code?: string;
            ssr?: boolean;
            buildRoot?: string;
            outDir?: string;
            cwd?: string;
        };

        const transformCases: TransformCase[] = [
            {
                description: 'a plain module with named exports',
                id: '/build/src/util.ts',
                code: 'export const helper = () => 1;\nexport function other() { return 2; }',
                expected: 'untouched',
            },
            {
                description: 'a module with a default export',
                id: '/build/src/App.tsx',
                code: 'export default function App() { return null; }',
                expected: 'untouched',
            },
            { description: 'a backend file', id: backendId, expected: 'proxied' },
            {
                description: 'a backend file with an ?import query',
                id: `${backendId}?import`,
                expected: 'proxied',
            },
            {
                description: 'a backend file with a #fragment',
                id: `${backendId}#fragment`,
                expected: 'proxied',
            },
            {
                description: 'a backend file with a query and a #fragment',
                id: `${backendId}?import#fragment`,
                expected: 'proxied',
            },
            {
                description: 'a local-execution backend load from SSR',
                id: `${backendId}${LOCAL_EXECUTION_LOAD_SUFFIX}`,
                ssr: true,
                expected: 'untouched',
            },
            {
                description: 'a local-execution-suffixed backend import outside SSR',
                id: `${backendId}${LOCAL_EXECUTION_LOAD_SUFFIX}`,
                expected: 'proxied',
            },
            {
                description: 'a local-execution-suffixed non-backend helper',
                id: `/build/src/helper.ts${LOCAL_EXECUTION_LOAD_SUFFIX}`,
                ssr: true,
                expected: 'untouched',
            },
            {
                description: 'a backend file whose query mentions node_modules',
                id: `${backendId}?from=/node_modules/pkg/`,
                expected: 'proxied',
            },
            {
                description: 'a \\0-prefixed virtual backend id while cwd is inside node_modules',
                id: '\0virtual.backend.ts',
                cwd: nodeModulesPackageDirectory,
                expected: 'proxied',
            },
            {
                description: 'a \\0-prefixed proxy of a node_modules backend file',
                id: '\0/build/node_modules/pkg/remote.backend.ts?commonjs-proxy',
                expected: 'untouched',
            },
            {
                description: 'a Windows-separator backend id',
                id: 'C:\\proj\\src\\a.backend.ts',
                buildRoot: 'C:\\proj',
                outDir: 'C:\\proj\\dist',
                expected: 'proxied',
            },
            {
                description: 'a Windows drive backend id with forward slashes',
                id: 'C:/proj/src/a.backend.ts',
                buildRoot: 'C:\\proj',
                outDir: 'C:\\proj\\dist',
                expected: 'proxied',
            },
            {
                description: 'a Windows-separator backend id inside node_modules',
                id: 'C:\\proj\\node_modules\\pkg\\a.backend.ts',
                buildRoot: 'C:\\proj',
                outDir: 'C:\\proj\\dist',
                expected: 'untouched',
            },
            {
                description: 'a backend file in an app under a dist ancestor',
                id: '/srv/dist/my-app/src/a.backend.ts',
                buildRoot: '/srv/dist/my-app',
                outDir: '/srv/dist/my-app/dist',
                expected: 'proxied',
            },
            {
                description: 'a backend file in an app under a node_modules_legacy ancestor',
                id: '/x/node_modules_legacy/app/src/a.backend.ts',
                buildRoot: '/x/node_modules_legacy/app',
                outDir: '/x/node_modules_legacy/app/dist',
                expected: 'proxied',
            },
            {
                description: 'a backend file in an app under a node_modules ancestor',
                id: '/home/user/node_modules/app/src/a.backend.ts',
                buildRoot: '/home/user/node_modules/app',
                outDir: '/home/user/node_modules/app/dist',
                expected: 'proxied',
            },
            {
                description:
                    'a hoisted package backend file beside an app under a node_modules ancestor',
                id: '/home/user/node_modules/pkg/a.backend.ts',
                buildRoot: '/home/user/node_modules/app',
                outDir: '/home/user/node_modules/app/dist',
                expected: 'untouched',
            },
            {
                description: 'a linked backend file outside the build root',
                id: '/repo/shared/a.backend.ts',
                buildRoot: '/repo/app',
                outDir: '/repo/app/dist',
                expected: 'proxied',
            },
            {
                description: 'a backend file in a node_modules_compat directory',
                id: '/build/src/node_modules_compat/a.backend.ts',
                expected: 'proxied',
            },
            {
                description: 'a backend file in a node_modules package',
                id: '/build/node_modules/pkg/remote.backend.ts',
                expected: 'untouched',
            },
            {
                description:
                    'a backend file in a hoisted node_modules package above the build root',
                id: '/node_modules/pkg/remote.backend.ts',
                expected: 'untouched',
            },
            {
                description: 'a backend file in the .yarn cache',
                id: '/build/.yarn/cache/pkg/remote.backend.ts',
                expected: 'untouched',
            },
            {
                description: 'a backend file in the build outDir',
                id: '/build/dist/assets/built.backend.js',
                expected: 'untouched',
            },
            {
                description: 'a backend file when the outDir is the build root',
                id: backendId,
                outDir: '/build',
                expected: 'proxied',
            },
        ];

        const getPluginForCase = ({
            buildRoot = '/build',
            outDir = '/build/dist',
        }: TransformCase) =>
            getVitePlugin({
                ...defaultOptions,
                context: {
                    ...defaultOptions.context,
                    buildRoot,
                    bundler: { ...defaultOptions.context.bundler, outDir },
                },
            });

        const getOutcome = (result: unknown): string => {
            if (result === null) {
                return 'untouched';
            }
            const transformedCode = extractTransformedCode(result);
            return transformedCode?.includes('executeBackendFunction') ? 'proxied' : 'unexpected';
        };

        test('Should keep only the backend-file include in the native filter', () => {
            const plugin = getVitePlugin(defaultOptions);
            const { filter } = getTransformObject(plugin);

            expect(filter?.id).toEqual({ include: [BACKEND_FILE_WITH_QUERY_RE] });
        });

        test.each(transformCases)(
            'Should leave the handler result $expected for $description',
            (transformCase) => {
                const originalCwd = process.cwd();
                const plugin = getPluginForCase(transformCase);
                const handler = getTransformHandler(plugin);

                let result: unknown;
                try {
                    process.chdir(transformCase.cwd ?? originalCwd);
                    result = handler.call(
                        transformContext,
                        transformCase.code ?? backendCode,
                        transformCase.id,
                        { ssr: transformCase.ssr },
                    );
                } finally {
                    process.chdir(originalCwd);
                }
                const outcome = getOutcome(result);

                expect(outcome).toBe(transformCase.expected);
            },
        );

        test('Should register a #fragment backend import under the file itself, as a plain import does', () => {
            const plugin = getVitePlugin(defaultOptions);
            const handler = getTransformHandler(plugin);

            const plainResult = handler.call(transformContext, backendCode, backendId, {});
            const fragmentId = `${backendId}#fragment`;
            const fragmentResult = handler.call(transformContext, backendCode, fragmentId, {});
            const plainCode = extractTransformedCode(plainResult);
            const fragmentCode = extractTransformedCode(fragmentResult);

            expect(fragmentCode).toBe(plainCode);
        });

        // unplugin copies raw `vite` hooks onto the plugin, so nothing re-applies `filter` for Vite < 6.3.
        test('Should leave the handler unwrapped after unplugin composes the plugin, and still skip non-backend ids', () => {
            const appsVitePlugin = getVitePlugin(defaultOptions);
            const unpluginOutput = createUnplugin(() => ({
                name: 'apps-under-test',
                vite: appsVitePlugin,
            })).vite();
            const [composedPlugin] = [unpluginOutput].flat();
            const rawTransform = getTransformObject(appsVitePlugin);
            const composedTransform = getTransformObject(composedPlugin);
            const composedHandler = getTransformHandler(composedPlugin);

            const result = composedHandler.call(
                transformContext,
                'export const helper = 1;',
                '/build/src/util.ts',
            );

            expect(composedTransform.handler).toBe(rawTransform.handler);
            expect(result).toBeNull();
        });

        describe('native filter on a real Vite 6.3 dev server', () => {
            const PIPELINE_STOP_MESSAGE = 'pipeline-stop: probe finished';
            let server: ViteDevServer;
            const idsReachingHandler = new Set<string>();

            beforeAll(async () => {
                const appsVitePlugin = getVitePlugin(defaultOptions);
                const { filter } = getTransformObject(appsVitePlugin);
                const probePlugin: VitePlugin = {
                    name: 'native-filter-probe',
                    enforce: 'pre',
                    transform: {
                        filter,
                        handler(_code, id) {
                            idsReachingHandler.add(id);
                            return null;
                        },
                    },
                };
                // Stops each run before Vite's built-in transforms, which reject ids missing from the module graph.
                const stopPlugin: VitePlugin = {
                    name: 'pipeline-stop',
                    enforce: 'pre',
                    transform() {
                        throw new Error(PIPELINE_STOP_MESSAGE);
                    },
                };
                server = await createServer({
                    configFile: false,
                    root: __dirname,
                    logLevel: 'silent',
                    appType: 'custom',
                    server: { middlewareMode: true, hmr: false, ws: false },
                    optimizeDeps: { noDiscovery: true, include: [] },
                    plugins: [probePlugin, stopPlugin],
                });
                for (const { id, ssr } of transformCases) {
                    const environment = ssr ? server.environments.ssr : server.environments.client;
                    try {
                        await environment.pluginContainer.transform('export const value = 1;', id);
                    } catch (error) {
                        const isPipelineStop =
                            error instanceof Error && error.message.includes(PIPELINE_STOP_MESSAGE);
                        if (!isPipelineStop) {
                            throw error;
                        }
                    }
                }
            });

            afterAll(async () => {
                await server.close();
            });

            const proxiedCases = transformCases.filter(({ expected }) => expected === 'proxied');
            const nonBackendCases = transformCases.filter(
                ({ id }) => !BACKEND_FILE_WITH_QUERY_RE.test(id),
            );

            test.each(proxiedCases)(
                'Should let the native filter reach the handler for $description',
                ({ id }) => {
                    const reachedHandler = idsReachingHandler.has(id);

                    expect(reachedHandler).toBe(true);
                },
            );

            test.each(nonBackendCases)(
                'Should let the native filter skip $description',
                ({ id }) => {
                    const reachedHandler = idsReachingHandler.has(id);

                    expect(reachedHandler).toBe(false);
                },
            );
        });
    });

    describe('resolveId suffix propagation through a plain helper module', () => {
        const entryFile = '/build/src/backend/entry.backend.ts';
        const helperImporter = '/build/src/helper.ts';
        const nestedBackendFile = '/build/src/backend/otherHandler.backend.ts';

        /** Resolves the entry's own `./helper` import, marking `helperImporter` as part of whichever subgraph tracking Set (if any) is active on the AsyncLocalStorage store at call time — the same first hop a real local execution's traversal makes. */
        const resolveEntryToHelper = (resolveIdHandler: Function) =>
            resolveIdHandler.call(
                { resolve: jest.fn(async () => ({ id: helperImporter })) },
                './helper',
                `${entryFile}${LOCAL_EXECUTION_LOAD_SUFFIX}`,
                { ssr: true },
            );

        /** Resolves a nested backend import from the helper — the second hop that should only inherit the suffix if `helperImporter` is still recognized as part of the current subgraph. */
        const resolveHelperToBackendFile = (resolveIdHandler: Function) =>
            resolveIdHandler.call(
                { resolve: jest.fn(async () => ({ id: nestedBackendFile })) },
                './otherHandler.backend',
                helperImporter,
                { ssr: true },
            );

        test('Should give the helper itself a suffixed identity, distinct from an ordinary (unsuffixed) resolution of the same file', async () => {
            const plugin = getVitePlugin(defaultOptions);
            const resolveIdHandler = getResolveIdHandler(plugin);

            const result = await localExecutionResolutionContext.run(new Set(), () =>
                resolveEntryToHelper(resolveIdHandler),
            );

            expect((result as { id: string } | null)?.id).toBe(
                `${helperImporter}${LOCAL_EXECUTION_LOAD_SUFFIX}`,
            );
        });

        test('Should propagate the suffix onto a nested backend import reached through a helper resolved earlier in the same local execution', async () => {
            const plugin = getVitePlugin(defaultOptions);
            const resolveIdHandler = getResolveIdHandler(plugin);

            const result = await localExecutionResolutionContext.run(new Set(), async () => {
                // Chains the first hop's actual returned id into the second call's importer, the
                // same suffixed identity a real nested import from this helper would present.
                const { id: suffixedHelperImporter } = (await resolveEntryToHelper(
                    resolveIdHandler,
                )) as { id: string };
                return resolveIdHandler.call(
                    { resolve: jest.fn(async () => ({ id: nestedBackendFile })) },
                    './otherHandler.backend',
                    suffixedHelperImporter,
                    { ssr: true },
                );
            });

            expect((result as { id: string } | null)?.id).toBe(
                `${nestedBackendFile}${LOCAL_EXECUTION_LOAD_SUFFIX}`,
            );
        });

        // A plain module-level Set (instead of one scoped per execution via AsyncLocalStorage)
        // would still recognize `helperImporter` here, serving real backend code into what
        // should be an ordinary, unrelated SSR resolution of the same helper.
        test('Should NOT propagate the suffix onto the same helper importer once no local execution is in flight, even though an earlier execution already traversed it', async () => {
            const plugin = getVitePlugin(defaultOptions);
            const resolveIdHandler = getResolveIdHandler(plugin);

            // A prior, now-finished local execution traverses entry -> helper.
            await localExecutionResolutionContext.run(new Set(), () =>
                resolveEntryToHelper(resolveIdHandler),
            );

            // Later, unrelated SSR resolution of the same helper importer — outside any local
            // execution's own load.
            const result = await resolveHelperToBackendFile(resolveIdHandler);

            expect(result).toBeNull();
        });

        // The importer-suffix branch must be ssr-scoped too, or a client-mode resolution using
        // an SSR-only suffixed id as importer would inherit the marker and leak real backend code.
        test('Should NOT propagate the suffix through a suffixed importer when the resolution is not SSR', async () => {
            const plugin = getVitePlugin(defaultOptions);
            const resolveIdHandler = getResolveIdHandler(plugin);

            const result = await resolveIdHandler.call(
                { resolve: jest.fn(async () => ({ id: nestedBackendFile })) },
                './otherHandler.backend',
                `${entryFile}${LOCAL_EXECUTION_LOAD_SUFFIX}`,
                { ssr: false },
            );

            expect(result).toBeNull();
        });
    });

    test('Should inject the apps runtime', () => {
        getVitePlugin(defaultOptions);

        expect(mockInject).toHaveBeenCalledWith({
            type: 'file',
            position: InjectPosition.MIDDLE,
            value: expect.stringMatching(/[/\\]apps-runtime\.mjs$/),
        });
    });

    test('Should force @datadog/apps-backend and @datadog/action-catalog through the SSR transform pipeline instead of externalizing them', () => {
        // These SDKs ship ESM-only, but Vite's dev-server SSR mode externalizes node_modules by
        // default (a plain require()), which throws "Cannot use import statement outside a
        // module" for them — ssr.noExternal is what server.ssrLoadModule depends on to load them
        // correctly.
        const plugin = getVitePlugin(defaultOptions);
        const configHook = getConfigHandler(plugin);
        const config = configHook();

        expect(config).toEqual({
            ssr: {
                noExternal: ['@datadog/apps-backend', '@datadog/action-catalog'],
            },
        });
    });

    // Uses the real configureServer hook, not createDevServerMiddleware directly, to catch mode-forwarding regressions.
    test('Should route /__dd/executeAction to the cloud path when configureServer sees a dev-verify server.config.mode', async () => {
        const plugin = getVitePlugin(defaultOptions);
        const transformHandler = getTransformHandler(plugin);

        await transformHandler.call(
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

        // Unlike closeBundle's default mock (chunk metadata only), the cloud path bundles first and logs code.length, so this needs a real chunk `code`.
        mockViteBuild.mockImplementation(async (config) => {
            emitModuleParsed(
                config,
                '/build/src/backend/myHandler.backend.ts',
                'export function myHandler() {} export function otherFunc() {}',
            );
            return {
                output: [{ type: 'chunk', isEntry: true, name: bundleName1, code: '// bundled' }],
            };
        });

        const use = jest.fn();
        const ssrLoadModule = jest.fn();
        const configureServer = getConfigureServer(plugin);
        // configureServer resolves auth from the environment; restored immediately after use.
        const restoreEnv = cleanEnv();
        process.env.DD_API_KEY = 'test-api-key';
        process.env.DD_APP_KEY = 'test-app-key';
        configureServer({
            middlewares: { use },
            ssrLoadModule,
            config: { mode: DEV_VERIFY_MODE },
        });
        restoreEnv();

        expect(use).toHaveBeenCalledTimes(1);
        const [registeredMiddleware] = use.mock.calls[0];
        if (!isDevServerMiddleware(registeredMiddleware)) {
            throw new Error(
                'Expected middlewares.use to have been called with a middleware function',
            );
        }
        const middleware = registeredMiddleware;

        const apiScope = nock(DD_API_ORIGIN)
            .post('/api/v2/app-builder/queries/preview-async')
            .reply(200, { data: { id: 'receipt-dev-verify' } })
            .get('/api/v2/app-builder/queries/execution-long-polling/receipt-dev-verify')
            .reply(200, {
                data: {
                    attributes: {
                        done: true,
                        outputs: { data: { result: 'via cloud' } },
                    },
                },
            });

        const req = createMockRequest('/__dd/executeAction', {
            functionName: bundleName1,
            args: ['world'],
        });
        const res = createMockResponse();

        middleware(req, res, jest.fn());
        await res.done;

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.getBody());
        expect(body.result).toEqual({ data: { result: 'via cloud' } });
        expect(apiScope.isDone()).toBe(true);
        expect(ssrLoadModule).not.toHaveBeenCalled();
    });
});
