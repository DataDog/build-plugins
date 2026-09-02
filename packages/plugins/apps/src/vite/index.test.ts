// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getVitePlugin } from '@dd/apps-plugin/vite/index';
import type { ViteBundler } from '@dd/apps-plugin/vite/index';
import { localExecutionResolutionContext } from '@dd/apps-plugin/vite/local-execution';
import { InjectPosition } from '@dd/core/types';
import { getContextMock, getRepositoryDataMock, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import { parseAst } from 'rollup/parseAst';
import type { PluginContext } from 'rollup';
import type { ViteDevServer } from 'vite';

import * as auth from '../auth';
import { encodeQueryName } from '../backend/encodeQueryName';
import type { BackendFunction } from '../backend/types';
import { LOCAL_EXECUTION_LOAD_SUFFIX } from '../constants';

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
        const configHook = plugin!.config as () => { ssr: { noExternal: string[] } };
        const config = configHook();

        expect(config).toEqual({
            ssr: {
                noExternal: ['@datadog/apps-backend', '@datadog/action-catalog'],
            },
        });
    });
});
