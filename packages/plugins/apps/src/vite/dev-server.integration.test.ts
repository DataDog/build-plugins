// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Real coverage for the local-execution path's module resolution: no mocked
 * `viteBuild`/`loadModule`, no hand-written stand-in module. This spins up
 * a real Vite dev server (`createServer`, middleware mode — no port bound)
 * rooted at the same `apps_backend_project` fixture `backend/integration.test.ts`
 * uses, and lets its real `ssrLoadModule` import a real `.backend.ts` file
 * directly and execute it via the real `/__dd/executeAction` HTTP handler,
 * including resolving `@datadog/apps-backend` from the fixture's own project
 * root rather than build-plugins' own dependency tree.
 *
 * The nested-import test below registers the real `getVitePlugin()` hooks
 * on this server, needed specifically to exercise `resolveId`'s
 * `LOCAL_EXECUTION_LOAD_SUFFIX` propagation against Vite's own real module
 * resolution, which a mocked `this.resolve()` can't reproduce.
 *
 * `@datadog/apps-backend` and `@datadog/action-catalog` are both real,
 * locally-resolvable fixture packages — see `packages/tests/src/_jest/
 * fixtures/node_modules/@datadog/apps-backend` and `.../@datadog/action-catalog`
 * — rather than mocked modules, so the connection-ID coverage below exercises
 * Vite's actual SSR transform output, not a hand-crafted AST shape a real
 * transform would never produce.
 */

import { getAuthenticatedRequest } from '@dd/apps-plugin/auth';
import { collectModuleGraphFromServer } from '@dd/apps-plugin/vite/dev-server-module-graph';
import { createDevServerMiddleware } from '@dd/apps-plugin/vite/dev-server';
import { getVitePlugin } from '@dd/apps-plugin/vite/index';
import type { AuthOptionsWithDefaults } from '@dd/core/types';
import { getContextMock, getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import nock from 'nock';
import path from 'path';
import { build, createServer, type Plugin, type ViteDevServer } from 'vite';

import { extractConnectionIdsFromModuleGraph } from '../backend/ast-parsing/extract-connection-ids-from-module-graph';
import { encodeQueryName } from '../backend/encodeQueryName';
import type { BackendFunction } from '../backend/types';

const FIXTURE_ROOT = path.resolve(
    __dirname,
    '../../../../tests/src/_jest/fixtures/apps_backend_project',
);

const getRuntimeUsersFunc: BackendFunction = {
    relativePath: 'getRuntimeUsers',
    name: 'getRuntimeUsers',
    absolutePath: path.join(FIXTURE_ROOT, 'getRuntimeUsers.backend.ts'),
    allowedConnectionIds: [],
};

function createMockRequest(url: string, body: Record<string, unknown>): IncomingMessage {
    const req = new EventEmitter() as unknown as IncomingMessage;
    req.method = 'POST';
    req.url = url;
    process.nextTick(() => {
        (req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)));
        (req as unknown as EventEmitter).emit('end');
    });
    return req;
}

function createMockResponse() {
    let body = '';
    let resolveDone: () => void;
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    const res = {
        statusCode: 200,
        setHeader: jest.fn(),
        end: jest.fn((data: string) => {
            body = data || '';
            resolveDone();
        }),
        getBody() {
            return body;
        },
        done,
    };
    return res as typeof res & ServerResponse;
}

const nestedImportFunc: BackendFunction = {
    relativePath: 'nestedImport',
    name: 'usesNestedImport',
    absolutePath: path.join(FIXTURE_ROOT, 'nestedImport.backend.ts'),
    allowedConnectionIds: [],
};

const viaHelperFunc: BackendFunction = {
    relativePath: 'viaHelper',
    name: 'usesHelper',
    absolutePath: path.join(FIXTURE_ROOT, 'viaHelper.backend.ts'),
    allowedConnectionIds: [],
};

// Never referenced by another test in this file — the cold-entry test below
// needs a module its shared beforeAll server has genuinely never loaded.
const noSdkFunc: BackendFunction = {
    relativePath: 'noSdk',
    name: 'noSdkFunction',
    absolutePath: path.join(FIXTURE_ROOT, 'noSdk.backend.ts'),
    allowedConnectionIds: [],
};

const actionCatalogCallFunc: BackendFunction = {
    relativePath: 'actionCatalogCall',
    name: 'postMessage',
    absolutePath: path.join(FIXTURE_ROOT, 'actionCatalogCall.backend.ts'),
    allowedConnectionIds: [],
};

const mixedImportsFunc: BackendFunction = {
    relativePath: 'mixedImports',
    name: 'usesMixedImports',
    absolutePath: path.join(FIXTURE_ROOT, 'mixedImports.backend.ts'),
    allowedConnectionIds: [],
};

describe('Dev Server Middleware — real end-to-end local execution', () => {
    let server: ViteDevServer;

    beforeAll(async () => {
        const appsPlugin: Plugin = {
            name: 'dd-apps-test',
            ...getVitePlugin({
                bundler: { build },
                context: getContextMock({ buildRoot: FIXTURE_ROOT }),
                options: {
                    authOverrides: { method: 'apiKey' },
                    include: [],
                    dryRun: true,
                },
            }),
        };

        server = await createServer({
            configFile: false,
            root: FIXTURE_ROOT,
            logLevel: 'silent',
            server: { middlewareMode: true, hmr: false },
            plugins: [appsPlugin],
            // Local execution only ever goes through ssrLoadModule, never the
            // client bundle — Vite's auto-crawl-and-pre-bundle step exists for
            // the browser path this feature never uses, and a fixture-only
            // dependency (like the fake @datadog/action-catalog package below)
            // can trip it up in ways that have nothing to do with what this
            // suite is actually testing.
            optimizeDeps: { noDiscovery: true },
        });
    });

    afterAll(async () => {
        await server.close();
    });

    test('Should import a real backend function directly via the real Vite dev server and execute it locally, with a real @datadog/apps-backend typed import resolving $.Source correctly', async () => {
        const middleware = createDevServerMiddleware(
            build,
            server.ssrLoadModule.bind(server),
            () => [getRuntimeUsersFunc],
            async () => [],
            { site: 'datadoghq.com' },
            // No auth configured — this function never calls $.Actions.
            undefined,
            FIXTURE_ROOT,
            getMockLogger(),
        );

        const req = createMockRequest('/__dd/executeAction', {
            functionName: encodeQueryName(getRuntimeUsersFunc),
            args: ['e2e-test'],
        });
        const res = createMockResponse();

        middleware(req, res, jest.fn());
        await res.done;

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.getBody());
        expect(body.success).toBe(true);
        expect(body.result).toEqual({
            data: {
                label: 'e2e-test',
                executionUser: { id: 'local-dev', orgId: 'local-dev-org' },
                initiatingUser: { id: 'local-dev', orgId: 'local-dev-org' },
            },
        });
    }, 30000);

    // Real coverage for the resolveId propagation fix in vite/index.ts:
    // nestedImport.backend.ts statically imports plainEcho from
    // getRuntimeUsers.backend.ts. Without propagating
    // LOCAL_EXECUTION_LOAD_SUFFIX onto that nested import, Vite would
    // resolve it unsuffixed, the transform hook would replace it with the
    // frontend RPC-proxy stub (calling globalThis.DD_APPS_RUNTIME, which
    // doesn't exist server-side), and this would throw instead of returning
    // the real value.
    test('Should preserve real code for a nested *.backend.ts import, not swap it for the frontend RPC-proxy stub', async () => {
        const middleware = createDevServerMiddleware(
            build,
            server.ssrLoadModule.bind(server),
            () => [nestedImportFunc],
            async () => [],
            { site: 'datadoghq.com' },
            undefined,
            FIXTURE_ROOT,
            getMockLogger(),
        );

        const req = createMockRequest('/__dd/executeAction', {
            functionName: encodeQueryName(nestedImportFunc),
            args: ['nested-value'],
        });
        const res = createMockResponse();

        middleware(req, res, jest.fn());
        await res.done;

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.getBody());
        expect(body.success).toBe(true);
        expect(body.result).toEqual({ data: { value: 'nested-value' } });
    }, 30000);

    // Real coverage for the multi-hop case the single-hop propagation above
    // still misses: viaHelper.backend.ts imports helper.ts (a plain,
    // non-backend module), which itself imports plainEcho from
    // getRuntimeUsers.backend.ts. resolveId only appended the suffix when
    // the DIRECT importer string ended with it, so helper.ts (reached
    // through a suffixed importer, but never suffixed itself, since it
    // isn't a *.backend.ts file) became an unsuffixed importer for its own
    // import — silently dropping the marker one hop later than the direct
    // backend-to-backend case above, and swapping getRuntimeUsers.backend.ts
    // for its frontend RPC-proxy stub.
    test('Should preserve real code for a *.backend.ts import reached through an intermediate non-backend module', async () => {
        const middleware = createDevServerMiddleware(
            build,
            server.ssrLoadModule.bind(server),
            () => [viaHelperFunc],
            async () => [],
            { site: 'datadoghq.com' },
            undefined,
            FIXTURE_ROOT,
            getMockLogger(),
        );

        const req = createMockRequest('/__dd/executeAction', {
            functionName: encodeQueryName(viaHelperFunc),
            args: ['via-helper-value'],
        });
        const res = createMockResponse();

        middleware(req, res, jest.fn());
        await res.done;

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.getBody());
        expect(body.success).toBe(true);
        expect(body.result).toEqual({ data: { value: 'via-helper-value' } });
    }, 30000);

    // Regression coverage for the real configureServer-installed middleware,
    // not a hand-built one: every other test in this file constructs its own
    // middleware via createDevServerMiddleware(..., () => [], ...), which
    // bypasses getAllowedConnectionIds' real wiring entirely (a hardcoded
    // () => [] never exercises collectModuleGraphFromServer at all). Sending
    // the request through server.middlewares — the real Connect stack
    // getVitePlugin's own configureServer hook installed when this file's
    // createServer() call ran — is what actually proves the fix: before it,
    // getAllowedConnectionIds threw "missing module record" for the entry
    // module itself on every call, since moduleParsed (a Rollup-build-only
    // hook) never fires on a real Vite dev server.
    test('Should execute successfully through the real configureServer-installed middleware, walking a real multi-hop import graph', async () => {
        // Registers viaHelperFunc in the real backend-function registry —
        // configureServer's real middleware looks functions up there, and
        // registration is itself a side effect of transforming the file as
        // a normal (unsuffixed) frontend import, exactly like a real
        // frontend entry point importing the generated client SDK would.
        await server.ssrLoadModule(viaHelperFunc.absolutePath);

        const req = createMockRequest('/__dd/executeAction', {
            functionName: encodeQueryName(viaHelperFunc),
            args: ['real-middleware-value'],
        });
        const res = createMockResponse();

        server.middlewares(req, res, jest.fn());
        await res.done;

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.getBody());
        expect(body.success).toBe(true);
        expect(body.result).toEqual({ data: { value: 'real-middleware-value' } });
    }, 30000);

    // Regression coverage for a real getAllowedConnectionIds wired exactly as
    // vite/index.ts's configureServer builds it, on the very first request
    // for an entry — no priming import beforehand. Uses noSdkFunc, which no
    // earlier test in this file touches: reusing nestedImportFunc or
    // viaHelperFunc here would already have a warm moduleGraph node (and
    // module-runner cache) left over from an earlier test against this same
    // shared beforeAll server, masking the real gap this test guards — on a
    // cold entry, Vite only ever registers the node under the fully-resolved
    // (suffixed) id handleExecuteAction's own loadModule call just produced,
    // and collectModuleGraphFromServer was looking it up by the bare path.
    test('Should compute allowed connection IDs on the very first request for an entry, with no prior priming import', async () => {
        const loadModule = server.ssrLoadModule.bind(server);
        // collectModuleGraphFromServer now appends LOCAL_EXECUTION_LOAD_SUFFIX internally,
        // so this closure only ever handles the bare id — matching vite/index.ts's real wiring.
        const getAllowedConnectionIds = async (entryId: string) =>
            extractConnectionIdsFromModuleGraph(
                entryId,
                await collectModuleGraphFromServer(server, entryId, FIXTURE_ROOT),
                FIXTURE_ROOT,
            );

        const middleware = createDevServerMiddleware(
            build,
            loadModule,
            () => [noSdkFunc],
            getAllowedConnectionIds,
            { site: 'datadoghq.com' },
            undefined,
            FIXTURE_ROOT,
            getMockLogger(),
        );

        const req = createMockRequest('/__dd/executeAction', {
            functionName: encodeQueryName(noSdkFunc),
            args: [],
        });
        const res = createMockResponse();

        middleware(req, res, jest.fn());
        await res.done;

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.getBody());
        expect(body.success).toBe(true);
        expect(body.result).toEqual({ data: { ok: true } });
    }, 30000);

    // Regression coverage for the connection-ID collector against a REAL
    // Vite SSR transform, not a hand-crafted AST fixture. Vite's SSR
    // transform rewrites every `import` into a `__vite_ssr_import__(...)`
    // call and resolves bare specifiers to absolute paths — neither shape
    // the plain-`ImportDeclaration` search in collectActionCatalogImports
    // (built for the untransformed syntax a real Rollup build sees) can
    // parse. Before collectModuleGraphFromServer started reading each
    // module's original source fresh from disk instead, this collector
    // silently returned an empty allowlist for every locally-executed
    // function that imports a typed action-catalog function — rejecting any
    // real connectionId-scoped call with "not in this function's allowed
    // connections: []", not because of a real access violation, but because
    // the collector could never see the import that should have allowed it.
    test('Should recognize a connectionId-scoped action-catalog call and allow it, not silently reject it', async () => {
        const loadModule = server.ssrLoadModule.bind(server);
        const getAllowedConnectionIds = async (entryId: string) =>
            extractConnectionIdsFromModuleGraph(
                entryId,
                await collectModuleGraphFromServer(server, entryId, FIXTURE_ROOT),
                FIXTURE_ROOT,
            );

        const auth: AuthOptionsWithDefaults = {
            apiKey: 'test-api-key',
            appKey: 'test-app-key',
            site: 'datadoghq.com',
        };
        const middleware = createDevServerMiddleware(
            build,
            loadModule,
            () => [actionCatalogCallFunc],
            getAllowedConnectionIds,
            auth,
            getAuthenticatedRequest('apiKey', auth, getMockLogger()),
            FIXTURE_ROOT,
            getMockLogger(),
        );

        // The connection-ID collector is the thing under test here, not the
        // real preview-async round trip (already covered by dev-server.test.ts
        // and local-execution.test.ts) — this only needs the request to get
        // past the allowedConnectionIds check, so a minimal reply is enough.
        const apiScope = nock('https://api.datadoghq.com')
            .post('/api/v2/app-builder/queries/preview-async')
            .reply(200, { data: { id: 'receipt-action-catalog' } })
            .get('/api/v2/app-builder/queries/execution-long-polling/receipt-action-catalog')
            .reply(200, { data: { attributes: { done: true, outputs: { ok: true } } } });

        const req = createMockRequest('/__dd/executeAction', {
            functionName: encodeQueryName(actionCatalogCallFunc),
            args: [],
        });
        const res = createMockResponse();

        middleware(req, res, jest.fn());
        await res.done;

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.getBody());
        expect(body.success).toBe(true);
        expect(body.result).toEqual({ data: { ok: true } });
        expect(apiScope.isDone()).toBe(true);
    }, 30000);

    // Coverage for a module mixing a static import with a top-level dynamic
    // import textually between two static ones. dev-server-module-graph.ts
    // now resolves each static specifier individually against the AST
    // instead of reading node.importedModules positionally (which mixes
    // static and dynamic imports with no documented ordering guarantee) —
    // this fixture exercises that resolution path directly. Note: verified
    // against a real Vite dev server that node.importedModules for an
    // SSR-loaded module doesn't actually include a non-local dynamic
    // import's target at all, so the specific silent-misattribution failure
    // this was meant to reproduce doesn't manifest on the old code either;
    // the new resolution approach is kept regardless since it's correct by
    // construction rather than relying on node.importedModules' undocumented
    // behavior.
    test('Should recognize a connectionId-scoped action-catalog call even when a top-level dynamic import sits between two static imports', async () => {
        const loadModule = server.ssrLoadModule.bind(server);
        const getAllowedConnectionIds = async (entryId: string) =>
            extractConnectionIdsFromModuleGraph(
                entryId,
                await collectModuleGraphFromServer(server, entryId, FIXTURE_ROOT),
                FIXTURE_ROOT,
            );

        const auth: AuthOptionsWithDefaults = {
            apiKey: 'test-api-key',
            appKey: 'test-app-key',
            site: 'datadoghq.com',
        };
        const middleware = createDevServerMiddleware(
            build,
            loadModule,
            () => [mixedImportsFunc],
            getAllowedConnectionIds,
            auth,
            getAuthenticatedRequest('apiKey', auth, getMockLogger()),
            FIXTURE_ROOT,
            getMockLogger(),
        );

        const apiScope = nock('https://api.datadoghq.com')
            .post('/api/v2/app-builder/queries/preview-async')
            .reply(200, { data: { id: 'receipt-mixed-imports' } })
            .get('/api/v2/app-builder/queries/execution-long-polling/receipt-mixed-imports')
            .reply(200, { data: { attributes: { done: true, outputs: { ok: true } } } });

        const req = createMockRequest('/__dd/executeAction', {
            functionName: encodeQueryName(mixedImportsFunc),
            args: ['hello'],
        });
        const res = createMockResponse();

        middleware(req, res, jest.fn());
        await res.done;

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.getBody());
        expect(body.success).toBe(true);
        expect(body.result).toEqual({ data: { ok: true } });
        expect(apiScope.isDone()).toBe(true);
    }, 30000);
});
