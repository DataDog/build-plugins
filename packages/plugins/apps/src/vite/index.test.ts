// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getVitePlugin, SSR_WARMUP_SETTING } from '@dd/apps-plugin/vite/index';
import type { ViteBundler } from '@dd/apps-plugin/vite/index';
import { localExecutionResolutionContext } from '@dd/apps-plugin/vite/local-execution';
import { outputFileSync, rmSync } from '@dd/core/helpers/fs';
import { InjectPosition } from '@dd/core/types';
import { clearDatadogEnv } from '@dd/tests/_jest/helpers/datadogEnv';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import {
    createMockRequest,
    createMockResponse,
    getContextMock,
    getRepositoryDataMock,
    mockLogFn,
} from '@dd/tests/_jest/helpers/mocks';
import { emitModuleParsed } from '@dd/tests/_jest/helpers/moduleParsed';
import fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import nock from 'nock';
import path from 'path';
import { parseAst } from 'rollup/parseAst';
import type { PluginContext } from 'rollup';
import { createUnplugin } from 'unplugin';
import {
    createServer,
    loadEnv,
    type ConfigEnv,
    type EnvironmentOptions,
    type Plugin as VitePlugin,
    type UserConfig,
    type ViteDevServer,
} from 'vite';

import * as auth from '../auth';
import { encodeQueryName } from '../backend/encodeQueryName';
import type { BackendFunction } from '../backend/types';
import {
    BACKEND_FILE_WITH_QUERY_RE,
    DEV_VERIFY_MODE,
    LOCAL_EXECUTION_LOAD_SUFFIX,
} from '../constants';

import * as buildPackage from './build-package';
import { dropEnvFileCredentials, loadEnvFileCredentials } from './dotenv-credentials';
import { makeProbeDirOutsideTmp } from './network-guard.fixtures';
import * as networkGuard from './network-guard';

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
    config: {
        root: string;
        mode: string;
        envDir: string | false;
        inlineConfig: { envFile?: false };
    };
    pluginContainer?: object;
    close: () => Promise<void>;
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
    // Runs the returned post hook too, as Vite does once every plugin's configureServer has run.
    return function callConfigureServer(server: FakeViteDevServer): void {
        const postHook: unknown = Reflect.apply(configureServer, undefined, [server]);
        if (typeof postHook === 'function') {
            postHook();
        }
    };
}

function isDevServerMiddleware(value: unknown): value is DevServerMiddleware {
    return typeof value === 'function';
}

type ConfigHookResult = {
    ssr: { noExternal: string[] };
};
type ConfigEnvironmentCall = (
    name: string,
    options: EnvironmentOptions,
    env: ConfigEnv,
) => EnvironmentOptions | undefined;

const DEV_SERVER_ENV: ConfigEnv = { command: 'serve', mode: 'development', isPreview: false };

// Narrows `plugin.config` to its handler via a runtime check, avoiding an `as` cast on its return
// value — mirrors `getConfigureServer` above.
function getConfigHandler(
    plugin: ReturnType<typeof getVitePlugin>,
): (userConfig?: UserConfig) => ConfigHookResult {
    const { config } = plugin ?? {};
    const handler = typeof config === 'object' && config !== null ? config.handler : config;
    if (typeof handler !== 'function') {
        throw new Error('Expected plugin.config to have a function handler');
    }
    return function callConfig(userConfig = {}): ConfigHookResult {
        const result: unknown = Reflect.apply(handler, undefined, [userConfig, DEV_SERVER_ENV]);
        if (!isConfigHookResult(result)) {
            throw new Error('Expected plugin.config to return a config object');
        }
        return result;
    };
}

function isConfigHookResult(value: unknown): value is ConfigHookResult {
    return typeof value === 'object' && value !== null && 'ssr' in value;
}

function getConfigEnvironmentHandler(
    plugin: ReturnType<typeof getVitePlugin>,
): ConfigEnvironmentCall {
    const { configEnvironment } = plugin ?? {};
    if (typeof configEnvironment !== 'function') {
        throw new Error('Expected plugin.configEnvironment to be the plain function-hook form');
    }
    return function callConfigEnvironment(name, options, env) {
        return Reflect.apply(configEnvironment, undefined, [name, options, env]);
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
    loadEnv: jest.fn(() => ({})),
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

function mockBuildWithParsedBackend() {
    mockViteBuild.mockImplementation(async (config) => {
        await emitModuleParsed(
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
const isAlwaysActive = () => true;

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
        tags: [],
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
            close: jest.fn(),
            config: { mode: 'development', envDir: false, root: '/build', inlineConfig: {} },
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
            close: jest.fn(),
            config: { mode: 'development', envDir: false, root: '/build', inlineConfig: {} },
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
            close: jest.fn(),
            config: { mode: 'development', envDir: false, root: '/build', inlineConfig: {} },
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

    // Exact shape: Vite 5 has no configEnvironment hook, so the warmup override must not live here.
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

    const countWarmupNotices = () =>
        mockLogFn.mock.calls.filter(
            ([text, level]) => level === 'warn' && String(text).includes(SSR_WARMUP_SETTING),
        ).length;

    const ssrWarmupCases: Array<{
        description: string;
        userConfig: UserConfig;
        environmentName?: string;
        mergedOptions: EnvironmentOptions;
        configEnv?: Partial<ConfigEnv>;
        expectedOverride: boolean;
        expectedNotices: number;
    }> = [
        {
            description: 'server.preTransformRequests is on',
            userConfig: { server: { preTransformRequests: true } },
            mergedOptions: {},
            expectedOverride: true,
            expectedNotices: 1,
        },
        {
            description: 'the merged SSR dev.preTransformRequests is on',
            userConfig: {},
            mergedOptions: { dev: { preTransformRequests: true } },
            expectedOverride: true,
            expectedNotices: 1,
        },
        {
            description: 'no warmup setting is given',
            userConfig: {},
            mergedOptions: {},
            expectedOverride: true,
            expectedNotices: 0,
        },
        {
            description: 'server.preTransformRequests is on but the SSR environment turns it off',
            userConfig: { server: { preTransformRequests: true } },
            mergedOptions: { dev: { preTransformRequests: false } },
            expectedOverride: true,
            expectedNotices: 0,
        },
        {
            description: 'it is vite preview',
            userConfig: { server: { preTransformRequests: true } },
            mergedOptions: {},
            configEnv: { isPreview: true },
            expectedOverride: false,
            expectedNotices: 0,
        },
        {
            description: 'it is a build',
            userConfig: { server: { preTransformRequests: true } },
            mergedOptions: {},
            configEnv: { command: 'build' },
            expectedOverride: false,
            expectedNotices: 0,
        },
        {
            description: 'the environment is not SSR',
            userConfig: { server: { preTransformRequests: true } },
            environmentName: 'client',
            mergedOptions: {},
            expectedOverride: false,
            expectedNotices: 0,
        },
    ];
    test.each(ssrWarmupCases)(
        'Should turn SSR import warmup off: $expectedOverride, with $expectedNotices notice(s), when $description',
        ({
            userConfig,
            environmentName,
            mergedOptions,
            configEnv,
            expectedOverride,
            expectedNotices,
        }) => {
            const plugin = getVitePlugin(defaultOptions);
            const configHook = getConfigHandler(plugin);
            const configEnvironment = getConfigEnvironmentHandler(plugin);
            const env = { ...DEV_SERVER_ENV, ...configEnv };

            configHook(userConfig);
            const environmentOptions = configEnvironment(
                environmentName ?? 'ssr',
                mergedOptions,
                env,
            );

            const ssrWarmup = environmentOptions?.dev?.preTransformRequests;
            expect(ssrWarmup === false).toBe(expectedOverride);
            expect(countWarmupNotices()).toBe(expectedNotices);
        },
    );

    test('Should give the SSR import warmup notice only once', () => {
        const plugin = getVitePlugin(defaultOptions);
        const configEnvironment = getConfigEnvironmentHandler(plugin);
        const mergedOptions = { dev: { preTransformRequests: true } };

        configEnvironment('ssr', mergedOptions, DEV_SERVER_ENV);
        configEnvironment('ssr', mergedOptions, DEV_SERVER_ENV);

        expect(countWarmupNotices()).toBe(1);
    });

    // Without auth both endpoints are off, and dev-verify sends every execution to the cloud.
    test.each([
        { scenario: 'no authentication', mode: 'development', withAuth: false, installs: 0 },
        { scenario: 'dev-verify mode', mode: DEV_VERIFY_MODE, withAuth: true, installs: 0 },
        { scenario: 'local execution', mode: 'development', withAuth: true, installs: 1 },
    ])(
        'Should install the sandbox guards only when local execution can run ($scenario)',
        ({ mode, withAuth, installs }) => {
            const plugin = getVitePlugin(defaultOptions);
            const installGuards = jest
                .spyOn(networkGuard, 'installGuards')
                .mockImplementation(() => undefined);
            const configureServer = getConfigureServer(plugin);
            const restoreEnv = clearDatadogEnv();
            if (withAuth) {
                process.env.DD_API_KEY = 'test-api-key';
                process.env.DD_APP_KEY = 'test-app-key';
            }

            try {
                configureServer({
                    middlewares: { use: jest.fn() },
                    ssrLoadModule: jest.fn(),
                    close: jest.fn(),
                    config: { mode, envDir: false, root: '/build', inlineConfig: {} },
                });

                expect(installGuards).toHaveBeenCalledTimes(installs);
            } finally {
                restoreEnv();
                installGuards.mockRestore();
            }
        },
    );

    test.each([
        { predates: true, warns: true },
        { predates: false, warns: false },
    ])(
        'Should warn that fs-extra/graceful-fs loaded before the dev server is unguarded (predates: $predates)',
        ({ predates, warns }) => {
            const plugin = getVitePlugin(defaultOptions);
            const installGuards = jest
                .spyOn(networkGuard, 'installGuards')
                .mockImplementation(() => undefined);
            const gracefulFsPredatesGuards = jest
                .spyOn(networkGuard, 'gracefulFsPredatesGuards')
                .mockReturnValue(predates);
            const configureServer = getConfigureServer(plugin);
            const restoreEnv = clearDatadogEnv();
            process.env.DD_API_KEY = 'test-api-key';
            process.env.DD_APP_KEY = 'test-app-key';

            try {
                configureServer({
                    middlewares: { use: jest.fn() },
                    ssrLoadModule: jest.fn(),
                    close: jest.fn(),
                    config: {
                        mode: 'development',
                        envDir: false,
                        root: '/build',
                        inlineConfig: {},
                    },
                });
                const warned = mockLogFn.mock.calls.some(
                    ([text, level]) =>
                        level === 'warn' && text === networkGuard.GRACEFUL_FS_UNGUARDED_WARNING,
                );

                expect(warned).toBe(warns);
            } finally {
                restoreEnv();
                installGuards.mockRestore();
                gracefulFsPredatesGuards.mockRestore();
            }
        },
    );

    // Each local execution installs again and fails closed, so the server itself must still start.
    test('Should keep the dev server starting when installing the sandbox guards throws', () => {
        const plugin = getVitePlugin(defaultOptions);
        const installGuards = jest.spyOn(networkGuard, 'installGuards').mockImplementation(() => {
            throw new Error('Cannot redefine property: cpSync');
        });
        const use = jest.fn();
        const configureServer = getConfigureServer(plugin);
        const restoreEnv = clearDatadogEnv();
        process.env.DD_API_KEY = 'test-api-key';
        process.env.DD_APP_KEY = 'test-app-key';

        try {
            expect(() =>
                configureServer({
                    middlewares: { use },
                    ssrLoadModule: jest.fn(),
                    close: jest.fn(),
                    config: {
                        mode: 'development',
                        envDir: false,
                        root: '/build',
                        inlineConfig: {},
                    },
                }),
            ).not.toThrow();
            expect(installGuards).toHaveBeenCalled();
            expect(use).toHaveBeenCalledTimes(1);
        } finally {
            restoreEnv();
            installGuards.mockRestore();
        }
    });

    // Vite 5 has no environment API, so a run's dynamic import calls the plugin container directly.
    test("Should run a Vite 5 plugin container's resolveId, load and transform outside a run's blocked scope", async () => {
        const cacheDir = makeProbeDirOutsideTmp('dd-vite5-container-');
        // A class, like Vite 5.4's PluginContainer, so the methods live on the prototype and use `this`.
        class FakePluginContainer {
            readonly calls: unknown[][] = [];
            async resolveId(...args: unknown[]) {
                return this.record('resolveId', args);
            }
            async load(...args: unknown[]) {
                return this.record('load', args);
            }
            async transform(...args: unknown[]) {
                return this.record('transform', args);
            }
            record(method: string, args: unknown[]) {
                const cacheFile = path.join(cacheDir, `${method}.json`);
                fs.writeFileSync(cacheFile, '{}');
                this.calls.push([method, ...args]);
                return method;
            }
        }
        const pluginContainer = new FakePluginContainer();
        const plugin = getVitePlugin(defaultOptions);
        const configureServer = getConfigureServer(plugin);
        const restoreEnv = clearDatadogEnv();
        process.env.DD_API_KEY = 'test-api-key';
        process.env.DD_APP_KEY = 'test-app-key';

        try {
            configureServer({
                middlewares: { use: jest.fn() },
                ssrLoadModule: jest.fn(),
                close: jest.fn(),
                config: { mode: 'development', envDir: false, root: '/build', inlineConfig: {} },
                pluginContainer,
            });
            const inRunPath = path.join(cacheDir, 'in-run.txt');
            const results = await networkGuard.runBlocked(async () => {
                const ssr = { ssr: true };
                const resolved = await pluginContainer.resolveId('/src/lazy.ts', undefined, ssr);
                const loaded = await pluginContainer.load('/src/lazy.ts', ssr);
                const transformed = await pluginContainer.transform('code', '/src/lazy.ts', ssr);
                expect(() => fs.writeFileSync(inRunPath, 'data')).toThrow(
                    networkGuard.FS_WRITE_BLOCKED_MESSAGE,
                );
                return [resolved, loaded, transformed];
            });
            const cacheFiles = fs.readdirSync(cacheDir).sort();

            expect(results).toEqual(['resolveId', 'load', 'transform']);
            expect(pluginContainer.calls).toEqual([
                ['resolveId', '/src/lazy.ts', undefined, { ssr: true }],
                ['load', '/src/lazy.ts', { ssr: true }],
                ['transform', 'code', '/src/lazy.ts', { ssr: true }],
            ]);
            expect(cacheFiles).toEqual(['load.json', 'resolveId.json', 'transform.json']);
        } finally {
            restoreEnv();
            rmSync(cacheDir);
        }
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
            await emitModuleParsed(
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
        const restoreEnv = clearDatadogEnv();
        process.env.DD_API_KEY = 'test-api-key';
        process.env.DD_APP_KEY = 'test-app-key';
        configureServer({
            middlewares: { use },
            ssrLoadModule,
            close: jest.fn(),
            config: { mode: DEV_VERIFY_MODE, envDir: false, root: '/build', inlineConfig: {} },
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

    test('Should load unprefixed .env values into process.env when the dev server starts', () => {
        const startedAt = Date.now();
        const envDir = getTempWorkingDir(`dd-apps-configure-dotenv-${startedAt}`);
        const envFilePath = path.join(envDir, '.env');
        outputFileSync(envFilePath, 'QA_CONFIGURE_SECRET=from-dotenv\n');
        const plugin = getVitePlugin({ ...defaultOptions, bundler: { ...mockVite, loadEnv } });
        const configureServer = getConfigureServer(plugin);
        const restoreEnv = clearDatadogEnv();

        try {
            configureServer({
                middlewares: { use: jest.fn() },
                ssrLoadModule: jest.fn(),
                close: jest.fn(),
                config: { root: envDir, mode: 'development', envDir, inlineConfig: {} },
            });
            const loggedValue = mockLogFn.mock.calls.some(([text]) =>
                String(text).includes('from-dotenv'),
            );
            // No auth is configured here, so the message must not promise backend execution.
            const claimedReadable = mockLogFn.mock.calls.some(([text]) =>
                String(text).includes('can read'),
            );

            const loadedMessage = expect.stringContaining(
                'Loaded QA_CONFIGURE_SECRET from .env files',
            );

            expect(process.env.QA_CONFIGURE_SECRET).toBe('from-dotenv');
            expect(mockLogFn).toHaveBeenCalledWith(loadedMessage, 'info');
            expect(loggedValue).toBe(false);
            expect(claimedReadable).toBe(false);
        } finally {
            dropEnvFileCredentials();
            delete process.env.QA_CONFIGURE_SECRET;
            restoreEnv();
            rmSync(envDir);
        }
    });

    test('Should drop the .env values a dev server loaded once its close resolves', async () => {
        const startedAt = Date.now();
        const envDir = getTempWorkingDir(`dd-apps-configure-dotenv-close-${startedAt}`);
        const envFilePath = path.join(envDir, '.env');
        outputFileSync(envFilePath, 'QA_CONFIGURE_CLOSE_SECRET=from-dotenv\n');
        const plugin = getVitePlugin({ ...defaultOptions, bundler: { ...mockVite, loadEnv } });
        const configureServer = getConfigureServer(plugin);
        const restoreEnv = clearDatadogEnv();
        const closeServer = jest.fn(async () => {
            expect(process.env.QA_CONFIGURE_CLOSE_SECRET).toBe('from-dotenv');
        });
        const server: FakeViteDevServer = {
            middlewares: { use: jest.fn() },
            ssrLoadModule: jest.fn(),
            config: { root: envDir, mode: 'development', envDir, inlineConfig: {} },
            close: closeServer,
        };

        try {
            configureServer(server);
            const loadedAtStart = process.env.QA_CONFIGURE_CLOSE_SECRET;
            await server.close();

            expect(loadedAtStart).toBe('from-dotenv');
            expect(closeServer).toHaveBeenCalledTimes(1);
            expect(process.env).not.toHaveProperty('QA_CONFIGURE_CLOSE_SECRET');
        } finally {
            dropEnvFileCredentials();
            delete process.env.QA_CONFIGURE_CLOSE_SECRET;
            restoreEnv();
            rmSync(envDir);
        }
    });

    test('Should keep Datadog auth from the shell and warn about Datadog keys in a .env file', () => {
        const startedAt = Date.now();
        const envDir = getTempWorkingDir(`dd-apps-configure-dotenv-auth-${startedAt}`);
        const envFilePath = path.join(envDir, '.env');
        outputFileSync(envFilePath, 'DD_API_KEY=dotenv-api-key\nDD_APP_KEY=dotenv-app-key\n');
        const plugin = getVitePlugin({ ...defaultOptions, bundler: { ...mockVite, loadEnv } });
        const configureServer = getConfigureServer(plugin);
        const restoreEnv = clearDatadogEnv();
        process.env.DD_OAUTH_ACCESS_TOKEN = 'shell-oauth-token';
        const getAuthenticatedRequest = jest.spyOn(auth, 'getAuthenticatedRequest');

        try {
            configureServer({
                middlewares: { use: jest.fn() },
                ssrLoadModule: jest.fn(),
                close: jest.fn(),
                config: { root: envDir, mode: 'development', envDir, inlineConfig: {} },
            });
            const ignoredMessage = expect.stringContaining('DD_API_KEY, DD_APP_KEY');
            const missingAuthMessage = expect.stringContaining('No authentication configured');
            const loggedValue = mockLogFn.mock.calls.some(([text]) =>
                String(text).includes('dotenv-api-key'),
            );

            expect(process.env).not.toHaveProperty('DD_API_KEY');
            expect(process.env.DD_OAUTH_ACCESS_TOKEN).toBe('shell-oauth-token');
            expect(getAuthenticatedRequest).toHaveReturned();
            expect(mockLogFn).toHaveBeenCalledWith(ignoredMessage, 'warn');
            expect(mockLogFn).not.toHaveBeenCalledWith(missingAuthMessage, 'warn');
            expect(loggedValue).toBe(false);
        } finally {
            dropEnvFileCredentials();
            getAuthenticatedRequest.mockRestore();
            restoreEnv();
            rmSync(envDir);
        }
    });

    test('Should warn about and ignore .env keys that change Node or process behavior', () => {
        const startedAt = Date.now();
        const envDir = getTempWorkingDir(`dd-apps-configure-dotenv-process-${startedAt}`);
        const envFilePath = path.join(envDir, '.env');
        outputFileSync(envFilePath, 'NODE_TLS_REJECT_UNAUTHORIZED=0\n');
        const plugin = getVitePlugin({ ...defaultOptions, bundler: { ...mockVite, loadEnv } });
        const configureServer = getConfigureServer(plugin);
        const restoreEnv = clearDatadogEnv();
        const shellValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

        try {
            configureServer({
                middlewares: { use: jest.fn() },
                ssrLoadModule: jest.fn(),
                close: jest.fn(),
                config: { root: envDir, mode: 'development', envDir, inlineConfig: {} },
            });
            const ignoredMessage = expect.stringContaining(
                'Ignoring NODE_TLS_REJECT_UNAUTHORIZED from .env files',
            );

            expect(process.env).not.toHaveProperty('NODE_TLS_REJECT_UNAUTHORIZED');
            expect(mockLogFn).toHaveBeenCalledWith(ignoredMessage, 'warn');
        } finally {
            dropEnvFileCredentials();
            if (shellValue !== undefined) {
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = shellValue;
            }
            restoreEnv();
            rmSync(envDir);
        }
    });

    test('Should keep the previous .env load when configureServer throws before it finishes', () => {
        const startedAt = Date.now();
        const envDir = getTempWorkingDir(`dd-apps-configure-dotenv-throws-${startedAt}`);
        const envFilePath = path.join(envDir, '.env');
        outputFileSync(envFilePath, 'QA_CONFIGURE_EARLIER=from-dotenv\n');
        loadEnvFileCredentials(
            loadEnv,
            { root: envDir, mode: 'development', envDir },
            isAlwaysActive,
        );
        outputFileSync(envFilePath, 'QA_CONFIGURE_LATER=from-dotenv\n');
        const plugin = getVitePlugin({ ...defaultOptions, bundler: { ...mockVite, loadEnv } });
        const configureServer = getConfigureServer(plugin);
        jest.spyOn(auth, 'getAuthenticatedRequest').mockImplementation(() => {
            throw new Error('unexpected auth failure');
        });

        try {
            const startServer = () =>
                configureServer({
                    middlewares: { use: jest.fn() },
                    ssrLoadModule: jest.fn(),
                    close: jest.fn(),
                    config: { root: envDir, mode: 'development', envDir, inlineConfig: {} },
                });

            expect(startServer).toThrow('unexpected auth failure');
            expect(process.env.QA_CONFIGURE_EARLIER).toBe('from-dotenv');
            expect(process.env).not.toHaveProperty('QA_CONFIGURE_LATER');
        } finally {
            dropEnvFileCredentials();
            delete process.env.QA_CONFIGURE_LATER;
            rmSync(envDir);
        }
    });

    // dev-verify sends every execution to the cloud, which never sees local .env values.
    test('Should not load .env files in dev-verify mode', () => {
        const startedAt = Date.now();
        const envDir = getTempWorkingDir(`dd-apps-configure-dotenv-verify-${startedAt}`);
        const envFilePath = path.join(envDir, '.env');
        outputFileSync(envFilePath, 'QA_CONFIGURE_VERIFY_SECRET=from-dotenv\n');
        const plugin = getVitePlugin({ ...defaultOptions, bundler: { ...mockVite, loadEnv } });
        const configureServer = getConfigureServer(plugin);
        const restoreEnv = clearDatadogEnv();

        try {
            configureServer({
                middlewares: { use: jest.fn() },
                ssrLoadModule: jest.fn(),
                close: jest.fn(),
                config: { root: envDir, mode: DEV_VERIFY_MODE, envDir, inlineConfig: {} },
            });
            const loadedMessage = expect.stringContaining('QA_CONFIGURE_VERIFY_SECRET');

            expect(process.env).not.toHaveProperty('QA_CONFIGURE_VERIFY_SECRET');
            expect(mockLogFn).not.toHaveBeenCalledWith(loadedMessage, 'info');
        } finally {
            dropEnvFileCredentials();
            delete process.env.QA_CONFIGURE_VERIFY_SECRET;
            restoreEnv();
            rmSync(envDir);
        }
    });

    // Vite 5 keeps envDir set when the inline envFile option is false.
    test("Should not load .env files when Vite's inline envFile option is false", () => {
        const startedAt = Date.now();
        const envDir = getTempWorkingDir(`dd-apps-configure-dotenv-envfile-${startedAt}`);
        const envFilePath = path.join(envDir, '.env');
        outputFileSync(envFilePath, 'QA_CONFIGURE_ENVFILE_SECRET=from-dotenv\n');
        const plugin = getVitePlugin({ ...defaultOptions, bundler: { ...mockVite, loadEnv } });
        const configureServer = getConfigureServer(plugin);
        const restoreEnv = clearDatadogEnv();

        try {
            configureServer({
                middlewares: { use: jest.fn() },
                ssrLoadModule: jest.fn(),
                close: jest.fn(),
                config: {
                    root: envDir,
                    mode: 'development',
                    envDir,
                    inlineConfig: { envFile: false },
                },
            });

            expect(process.env).not.toHaveProperty('QA_CONFIGURE_ENVFILE_SECRET');
        } finally {
            dropEnvFileCredentials();
            delete process.env.QA_CONFIGURE_ENVFILE_SECRET;
            restoreEnv();
            rmSync(envDir);
        }
    });

    // Vite 8 restarts with an internal close, so the replaced server's close never runs.
    test('Should drop the .env values when a restarted server closes, even if its predecessor never closed', async () => {
        const startedAt = Date.now();
        const envDir = getTempWorkingDir(`dd-apps-configure-dotenv-replaced-${startedAt}`);
        const envFilePath = path.join(envDir, '.env');
        outputFileSync(envFilePath, 'QA_CONFIGURE_REPLACED_SECRET=from-dotenv\n');
        const plugin = getVitePlugin({ ...defaultOptions, bundler: { ...mockVite, loadEnv } });
        const configureServer = getConfigureServer(plugin);
        const restoreEnv = clearDatadogEnv();
        const createServerObject = (): FakeViteDevServer => ({
            middlewares: { use: jest.fn() },
            ssrLoadModule: jest.fn(),
            close: jest.fn(async () => {}),
            config: { root: envDir, mode: 'development', envDir, inlineConfig: {} },
        });
        const server = createServerObject();
        const restartedServer = createServerObject();

        try {
            configureServer(server);
            configureServer(restartedServer);
            Object.assign(server, restartedServer);
            await server.close();

            expect(process.env).not.toHaveProperty('QA_CONFIGURE_REPLACED_SECRET');
        } finally {
            dropEnvFileCredentials();
            delete process.env.QA_CONFIGURE_REPLACED_SECRET;
            restoreEnv();
            rmSync(envDir);
        }
    });

    test("Should drop a replaced server's values when Vite swaps it for a server on another root", async () => {
        const startedAt = Date.now();
        const firstRoot = getTempWorkingDir(`dd-apps-configure-dotenv-first-root-${startedAt}`);
        const secondRoot = getTempWorkingDir(`dd-apps-configure-dotenv-second-root-${startedAt}`);
        const firstEnvFilePath = path.join(firstRoot, '.env');
        const secondEnvFilePath = path.join(secondRoot, '.env');
        outputFileSync(firstEnvFilePath, 'QA_CONFIGURE_FIRST_ROOT_SECRET=first\n');
        outputFileSync(secondEnvFilePath, 'QA_CONFIGURE_SECOND_ROOT_SECRET=second\n');
        const plugin = getVitePlugin({ ...defaultOptions, bundler: { ...mockVite, loadEnv } });
        const configureServer = getConfigureServer(plugin);
        const restoreEnv = clearDatadogEnv();
        const createServerObject = (root: string): FakeViteDevServer => ({
            middlewares: { use: jest.fn() },
            ssrLoadModule: jest.fn(),
            close: jest.fn(async () => {}),
            config: { root, mode: 'development', envDir: root, inlineConfig: {} },
        });
        const server = createServerObject(firstRoot);
        const restartedServer = createServerObject(secondRoot);

        try {
            configureServer(server);
            configureServer(restartedServer);
            Object.assign(server, restartedServer);
            await server.close();

            expect(process.env).not.toHaveProperty('QA_CONFIGURE_FIRST_ROOT_SECRET');
            expect(process.env).not.toHaveProperty('QA_CONFIGURE_SECOND_ROOT_SECRET');
        } finally {
            dropEnvFileCredentials();
            delete process.env.QA_CONFIGURE_FIRST_ROOT_SECRET;
            delete process.env.QA_CONFIGURE_SECOND_ROOT_SECRET;
            restoreEnv();
            rmSync(firstRoot);
            rmSync(secondRoot);
        }
    });

    const testRunCases = [
        { description: "mode 'test'", mode: 'test', vitest: undefined },
        { description: 'VITEST set', mode: 'development', vitest: 'true' },
    ];
    test.each(testRunCases)(
        'Should neither load nor drop .env values in a test run ($description)',
        ({ mode, vitest }) => {
            const startedAt = Date.now();
            const envDir = getTempWorkingDir(`dd-apps-configure-dotenv-test-run-${startedAt}`);
            const envFilePath = path.join(envDir, '.env');
            outputFileSync(envFilePath, 'QA_TEST_RUN_EARLIER=from-dotenv\n');
            loadEnvFileCredentials(
                loadEnv,
                { root: envDir, mode: 'development', envDir },
                isAlwaysActive,
            );
            outputFileSync(envFilePath, 'QA_TEST_RUN_SECRET=from-dotenv\n');
            const plugin = getVitePlugin({ ...defaultOptions, bundler: { ...mockVite, loadEnv } });
            const configureServer = getConfigureServer(plugin);
            const restoreEnv = clearDatadogEnv();
            const previousVitest = process.env.VITEST;
            if (vitest) {
                process.env.VITEST = vitest;
            }

            try {
                configureServer({
                    middlewares: { use: jest.fn() },
                    ssrLoadModule: jest.fn(),
                    close: jest.fn(),
                    config: { root: envDir, mode, envDir, inlineConfig: {} },
                });
                const skippedMessage = expect.stringContaining('Skipping .env file loading');

                expect(process.env).not.toHaveProperty('QA_TEST_RUN_SECRET');
                expect(process.env.QA_TEST_RUN_EARLIER).toBe('from-dotenv');
                expect(mockLogFn).toHaveBeenCalledWith(skippedMessage, 'debug');
            } finally {
                if (previousVitest === undefined) {
                    delete process.env.VITEST;
                } else {
                    process.env.VITEST = previousVitest;
                }
                dropEnvFileCredentials();
                delete process.env.QA_TEST_RUN_SECRET;
                restoreEnv();
                rmSync(envDir);
            }
        },
    );

    describe('.env files on a real Vite dev server', () => {
        let restoreEnv: () => void;

        beforeEach(() => {
            restoreEnv = clearDatadogEnv();
        });

        afterEach(() => {
            dropEnvFileCredentials();
            restoreEnv();
        });

        const createAppsDevServer = (root: string, extraPlugins: VitePlugin[] = []) => {
            const context = getContextMock({ buildRoot: root });
            const appsPlugin: VitePlugin = {
                name: 'dd-apps-test',
                ...getVitePlugin({ ...defaultOptions, bundler: { ...mockVite, loadEnv }, context }),
            };
            return createServer({
                configFile: false,
                root,
                logLevel: 'silent',
                appType: 'custom',
                server: { middlewareMode: true, hmr: false, ws: false },
                optimizeDeps: { noDiscovery: true, include: [] },
                plugins: [appsPlugin, ...extraPlugins],
            });
        };

        test('Should keep the loaded values when a restart fails after the config hooks ran', async () => {
            const startedAt = Date.now();
            const root = getTempWorkingDir(`dd-apps-dotenv-failed-restart-${startedAt}`);
            const envFilePath = path.join(root, '.env');
            outputFileSync(envFilePath, 'QA_RESTART_SECRET=from-dotenv\n');
            let shouldFailConfigResolved = false;
            const failingPlugin: VitePlugin = {
                name: 'fails-on-restart',
                configResolved() {
                    if (shouldFailConfigResolved) {
                        throw new Error('configResolved failed');
                    }
                },
            };
            let server: ViteDevServer | undefined;

            try {
                server = await createAppsDevServer(root, [failingPlugin]);
                const loadedAtStart = process.env.QA_RESTART_SECRET;
                outputFileSync(envFilePath, 'QA_RESTART_SECRET=edited\n');
                shouldFailConfigResolved = true;
                await server.restart();

                expect(loadedAtStart).toBe('from-dotenv');
                expect(process.env.QA_RESTART_SECRET).toBe('from-dotenv');
            } finally {
                await server?.close();
                rmSync(root);
            }
        });

        test('Should let the next dev server load its own .env value after one closes', async () => {
            const startedAt = Date.now();
            const firstRoot = getTempWorkingDir(`dd-apps-dotenv-closed-root-${startedAt}`);
            const secondRoot = getTempWorkingDir(`dd-apps-dotenv-next-root-${startedAt}`);
            const firstEnvFilePath = path.join(firstRoot, '.env');
            const secondEnvFilePath = path.join(secondRoot, '.env');
            outputFileSync(firstEnvFilePath, 'QA_CLOSED_SERVER_SECRET=first\n');
            outputFileSync(secondEnvFilePath, 'QA_CLOSED_SERVER_SECRET=second\n');
            let secondServer: ViteDevServer | undefined;

            try {
                const firstServer = await createAppsDevServer(firstRoot);
                const loadedByFirstServer = process.env.QA_CLOSED_SERVER_SECRET;
                await firstServer.close();
                const keptAfterClose = process.env.QA_CLOSED_SERVER_SECRET;
                secondServer = await createAppsDevServer(secondRoot);

                expect(loadedByFirstServer).toBe('first');
                expect(keptAfterClose).toBeUndefined();
                expect(process.env.QA_CLOSED_SERVER_SECRET).toBe('second');
            } finally {
                await secondServer?.close();
                delete process.env.QA_CLOSED_SERVER_SECRET;
                rmSync(firstRoot);
                rmSync(secondRoot);
            }
        });

        test('Should keep unchanged .env values after a restart until the restarted server closes', async () => {
            const startedAt = Date.now();
            const root = getTempWorkingDir(`dd-apps-dotenv-restart-unchanged-${startedAt}`);
            const envFilePath = path.join(root, '.env');
            outputFileSync(envFilePath, 'QA_RESTART_UNCHANGED_SECRET=unchanged\n');
            let server: ViteDevServer | undefined;

            try {
                server = await createAppsDevServer(root);
                await server.restart();
                const keptAfterRestart = process.env.QA_RESTART_UNCHANGED_SECRET;
                await server.close();

                expect(keptAfterRestart).toBe('unchanged');
                expect(process.env).not.toHaveProperty('QA_RESTART_UNCHANGED_SECRET');
            } finally {
                await server?.close();
                delete process.env.QA_RESTART_UNCHANGED_SECRET;
                rmSync(root);
            }
        });

        test('Should keep the .env values while another dev server for the same root runs', async () => {
            const startedAt = Date.now();
            const root = getTempWorkingDir(`dd-apps-dotenv-same-root-${startedAt}`);
            const envFilePath = path.join(root, '.env');
            outputFileSync(envFilePath, 'QA_SAME_ROOT_SECRET=from-dotenv\n');
            const servers: ViteDevServer[] = [];

            try {
                const mainServer = await createAppsDevServer(root);
                servers.push(mainServer);
                const helperServer = await createAppsDevServer(root);
                servers.push(helperServer);
                await helperServer.close();
                const keptAfterHelperClosed = process.env.QA_SAME_ROOT_SECRET;
                await mainServer.close();

                expect(keptAfterHelperClosed).toBe('from-dotenv');
                expect(process.env).not.toHaveProperty('QA_SAME_ROOT_SECRET');
            } finally {
                const closingServers = servers.map((server) => server.close());
                await Promise.all(closingServers);
                delete process.env.QA_SAME_ROOT_SECRET;
                rmSync(root);
            }
        });

        test('Should drop the .env values once every dev server for the root closed, including one that loaded nothing', async () => {
            const startedAt = Date.now();
            const root = getTempWorkingDir(`dd-apps-dotenv-empty-load-${startedAt}`);
            const servers: ViteDevServer[] = [];

            try {
                const emptyLoadServer = await createAppsDevServer(root);
                servers.push(emptyLoadServer);
                const envFilePath = path.join(root, '.env');
                outputFileSync(envFilePath, 'QA_EMPTY_LOAD_SECRET=from-dotenv\n');
                const loadingServer = await createAppsDevServer(root);
                servers.push(loadingServer);
                await emptyLoadServer.close();
                await loadingServer.close();

                expect(process.env).not.toHaveProperty('QA_EMPTY_LOAD_SECRET');
            } finally {
                const closingServers = servers.map((server) => server.close());
                await Promise.all(closingServers);
                delete process.env.QA_EMPTY_LOAD_SECRET;
                rmSync(root);
            }
        });

        test('Should end the load of a restart that a later plugin fails, keeping the old values until the old server closes', async () => {
            const startedAt = Date.now();
            const root = getTempWorkingDir(`dd-apps-dotenv-failed-configure-${startedAt}`);
            const envFilePath = path.join(root, '.env');
            outputFileSync(envFilePath, 'QA_FAILED_CONFIGURE_SECRET=from-dotenv\n');
            let shouldFailConfigureServer = false;
            // Vite never closes the server a failed restart was building.
            let abandonedServer: ViteDevServer | undefined;
            const failingPlugin: VitePlugin = {
                name: 'fails-in-configure-server',
                configureServer(newServer) {
                    if (shouldFailConfigureServer) {
                        abandonedServer = newServer;
                        throw new Error('configureServer failed');
                    }
                },
            };
            let server: ViteDevServer | undefined;

            try {
                server = await createAppsDevServer(root, [failingPlugin]);
                outputFileSync(envFilePath, 'QA_FAILED_CONFIGURE_SECRET=edited\n');
                shouldFailConfigureServer = true;
                await server.restart();
                const keptAfterFailedRestart = process.env.QA_FAILED_CONFIGURE_SECRET;
                await server.close();

                expect(keptAfterFailedRestart).toBe('from-dotenv');
                expect(process.env).not.toHaveProperty('QA_FAILED_CONFIGURE_SECRET');
            } finally {
                await server?.close();
                await abandonedServer?.close();
                delete process.env.QA_FAILED_CONFIGURE_SECRET;
                rmSync(root);
            }
        });

        test("Should hand a shared .env key to the other root's value once the first root's server closes", async () => {
            const startedAt = Date.now();
            const firstRoot = getTempWorkingDir(`dd-apps-dotenv-shared-first-${startedAt}`);
            const secondRoot = getTempWorkingDir(`dd-apps-dotenv-shared-second-${startedAt}`);
            const firstEnvFilePath = path.join(firstRoot, '.env');
            const secondEnvFilePath = path.join(secondRoot, '.env');
            outputFileSync(firstEnvFilePath, 'QA_SHARED_ROOT_SECRET=first\n');
            outputFileSync(secondEnvFilePath, 'QA_SHARED_ROOT_SECRET=second\n');
            const servers: ViteDevServer[] = [];

            try {
                const firstServer = await createAppsDevServer(firstRoot);
                servers.push(firstServer);
                const secondServer = await createAppsDevServer(secondRoot);
                servers.push(secondServer);
                const whileBothRun = process.env.QA_SHARED_ROOT_SECRET;
                await firstServer.close();
                const afterFirstClosed = process.env.QA_SHARED_ROOT_SECRET;
                await secondServer.close();
                const shadowedMessage = expect.stringContaining(
                    'Ignoring QA_SHARED_ROOT_SECRET from .env files. Another dev server',
                );
                const shadowWarnings = mockLogFn.mock.calls.filter(
                    ([text, level]) =>
                        level === 'warn' && String(text).includes('QA_SHARED_ROOT_SECRET'),
                );

                expect(whileBothRun).toBe('first');
                expect(afterFirstClosed).toBe('second');
                expect(process.env).not.toHaveProperty('QA_SHARED_ROOT_SECRET');
                expect(mockLogFn).toHaveBeenCalledWith(shadowedMessage, 'warn');
                expect(shadowWarnings).toHaveLength(1);
            } finally {
                const closingServers = servers.map((server) => server.close());
                await Promise.all(closingServers);
                delete process.env.QA_SHARED_ROOT_SECRET;
                rmSync(firstRoot);
                rmSync(secondRoot);
            }
        });

        test("Should keep another dev server's values when one restarts", async () => {
            const startedAt = Date.now();
            const firstRoot = getTempWorkingDir(`dd-apps-dotenv-first-root-${startedAt}`);
            const secondRoot = getTempWorkingDir(`dd-apps-dotenv-second-root-${startedAt}`);
            const firstEnvFilePath = path.join(firstRoot, '.env');
            const secondEnvFilePath = path.join(secondRoot, '.env');
            outputFileSync(firstEnvFilePath, 'QA_FIRST_ROOT_SECRET=first\n');
            outputFileSync(secondEnvFilePath, 'QA_SECOND_ROOT_SECRET=second\n');
            const servers: ViteDevServer[] = [];

            try {
                const firstServer = await createAppsDevServer(firstRoot);
                servers.push(firstServer);
                const secondServer = await createAppsDevServer(secondRoot);
                servers.push(secondServer);
                outputFileSync(firstEnvFilePath, 'QA_FIRST_ROOT_SECRET=first-edited\n');
                await firstServer.restart();

                expect(process.env.QA_FIRST_ROOT_SECRET).toBe('first-edited');
                expect(process.env.QA_SECOND_ROOT_SECRET).toBe('second');
            } finally {
                const closingServers = servers.map((server) => server.close());
                await Promise.all(closingServers);
                rmSync(firstRoot);
                rmSync(secondRoot);
            }
        });
    });
});
