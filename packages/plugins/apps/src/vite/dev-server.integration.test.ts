// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Real coverage for the local-execution path's module resolution — no mocked
 * `viteBuild`/`loadModule`, no hand-written stand-in module. Spins up a real Vite dev
 * server (`createServer`, middleware mode, no port bound) rooted at the same
 * `apps_backend_project` fixture `backend/integration.test.ts` uses, and lets its real
 * `ssrLoadModule` import and execute a real `.backend.ts` file via the real
 * `/__dd/executeAction` handler, including resolving `@datadog/apps-backend` from the
 * fixture's own project root.
 *
 * The nested-import test below registers the real `getVitePlugin()` hooks on this server
 * to exercise `resolveId`'s `LOCAL_EXECUTION_LOAD_SUFFIX` propagation against Vite's actual
 * module resolution, which a mocked `this.resolve()` can't reproduce.
 *
 * `@datadog/apps-backend` and `@datadog/action-catalog` are real, locally-resolvable
 * fixture packages (not mocked), so the connection-ID coverage below exercises Vite's
 * actual SSR transform output rather than a hand-crafted AST shape a real transform would
 * never produce.
 */

import { getAuthenticatedRequest } from '@dd/apps-plugin/auth';
import { collectModuleGraphFromServer } from '@dd/apps-plugin/vite/dev-server-module-graph';
import { createDevServerMiddleware } from '@dd/apps-plugin/vite/dev-server';
import { getVitePlugin } from '@dd/apps-plugin/vite/index';
import type { AuthOptionsWithDefaults } from '@dd/core/types';
import {
    createMockRequest,
    createMockResponse,
    getContextMock,
    getMockLogger,
} from '@dd/tests/_jest/helpers/mocks';
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

// Disable jitter/backoff so retry-relevant tests don't add unnecessary delay.
const mockLongPolling = {
    maxRetries: 10,
    timeoutMs: 40_000,
    jitter: false,
    exponentialBackoff: false,
};

const getRuntimeUsersFunc: BackendFunction = {
    relativePath: 'getRuntimeUsers',
    name: 'getRuntimeUsers',
    absolutePath: path.join(FIXTURE_ROOT, 'getRuntimeUsers.backend.ts'),
    allowedConnectionIds: [],
};

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
                    longPolling: mockLongPolling,
                },
            }),
        };

        server = await createServer({
            configFile: false,
            root: FIXTURE_ROOT,
            logLevel: 'silent',
            server: { middlewareMode: true, hmr: false },
            plugins: [appsPlugin],
            // Local execution only ever goes through ssrLoadModule, never the client bundle, so
            // Vite's auto-crawl-and-pre-bundle step (for the browser path) is disabled — a
            // fixture-only dependency like the fake @datadog/action-catalog package below can
            // otherwise trip it up in ways unrelated to what this suite tests.
            optimizeDeps: { noDiscovery: true },
        });
    });

    afterAll(async () => {
        await server.close();
    });

    test('Should import a real backend function directly via the real Vite dev server and execute it locally, with a real @datadog/apps-backend typed import resolving $.Source correctly', async () => {
        const auth: AuthOptionsWithDefaults = {
            apiKey: 'test-api-key',
            appKey: 'test-app-key',
            site: 'datadoghq.com',
        };
        const middleware = createDevServerMiddleware(
            build,
            server.ssrLoadModule.bind(server),
            () => [getRuntimeUsersFunc],
            async () => [],
            auth,
            getAuthenticatedRequest('apiKey', auth, getMockLogger()),
            mockLongPolling,
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

    // Real coverage for resolveId's LOCAL_EXECUTION_LOAD_SUFFIX propagation: nestedImport.backend.ts
    // statically imports plainEcho from getRuntimeUsers.backend.ts. Without propagating the suffix
    // onto that nested import, Vite would resolve it unsuffixed, the transform hook would swap in
    // the frontend RPC-proxy stub (calling the server-nonexistent globalThis.DD_APPS_RUNTIME), and
    // this would throw instead of returning the real value.
    test('Should preserve real code for a nested *.backend.ts import, not swap it for the frontend RPC-proxy stub', async () => {
        const auth: AuthOptionsWithDefaults = {
            apiKey: 'test-api-key',
            appKey: 'test-app-key',
            site: 'datadoghq.com',
        };
        const middleware = createDevServerMiddleware(
            build,
            server.ssrLoadModule.bind(server),
            () => [nestedImportFunc],
            async () => [],
            auth,
            getAuthenticatedRequest('apiKey', auth, getMockLogger()),
            mockLongPolling,
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

    // Real coverage for the multi-hop case the single-hop test above doesn't exercise:
    // viaHelper.backend.ts imports helper.ts (plain, non-backend), which imports plainEcho from
    // getRuntimeUsers.backend.ts. Suffix propagation must follow the chain through helper.ts
    // (reached via a suffixed importer, but never itself suffixed) — otherwise helper.ts becomes
    // an unsuffixed importer one hop past the direct case, and getRuntimeUsers.backend.ts
    // resolves to its frontend RPC-proxy stub instead of its real code.
    test('Should preserve real code for a *.backend.ts import reached through an intermediate non-backend module', async () => {
        const auth: AuthOptionsWithDefaults = {
            apiKey: 'test-api-key',
            appKey: 'test-app-key',
            site: 'datadoghq.com',
        };
        const middleware = createDevServerMiddleware(
            build,
            server.ssrLoadModule.bind(server),
            () => [viaHelperFunc],
            async () => [],
            auth,
            getAuthenticatedRequest('apiKey', auth, getMockLogger()),
            mockLongPolling,
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

    // Regression coverage for the real configureServer-installed middleware, not the hand-built
    // one every other test in this file uses via createDevServerMiddleware(..., () => [], ...),
    // which bypasses getAllowedConnectionIds' real wiring entirely. Sending the request through
    // server.middlewares — the real Connect stack getVitePlugin's configureServer hook installs —
    // is what actually exercises getAllowedConnectionIds resolving the entry's record without
    // moduleParsed, a Rollup-build-only hook that never fires on a real dev server.
    test('Should execute successfully through the real configureServer-installed middleware, walking a real multi-hop import graph', async () => {
        // Registers viaHelperFunc in the real backend-function registry — a side effect of
        // transforming the file as a normal (unsuffixed) frontend import, exactly like a real
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

    // Regression coverage for a real getAllowedConnectionIds, wired exactly as vite/index.ts's
    // configureServer builds it, on the very first request for an entry — no priming import
    // beforehand. Uses noSdkFunc since any other function here would already have a warm
    // moduleGraph node from an earlier test against this shared beforeAll server, masking the
    // invariant under test: on a cold entry, Vite only registers the node under the fully-resolved
    // (suffixed) id, so collectModuleGraphFromServer must look it up by that id, not the bare path.
    test('Should compute allowed connection IDs on the very first request for an entry, with no prior priming import', async () => {
        const loadModule = server.ssrLoadModule.bind(server);
        // collectModuleGraphFromServer appends LOCAL_EXECUTION_LOAD_SUFFIX internally, so this
        // closure only handles the bare id — matching vite/index.ts's real wiring.
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
            () => [noSdkFunc],
            getAllowedConnectionIds,
            auth,
            getAuthenticatedRequest('apiKey', auth, getMockLogger()),
            mockLongPolling,
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

    // Regression coverage for the connection-ID collector against a REAL Vite SSR transform, not a
    // hand-crafted AST fixture. Vite's SSR transform rewrites imports into
    // `__vite_ssr_import__(...)` calls the plain-`ImportDeclaration` search in
    // collectActionCatalogImports can't parse — before collectModuleGraphFromServer started
    // reading each module's original source from disk instead, this silently returned an empty
    // allowlist for any function importing a typed action-catalog function, rejecting real calls
    // with "not in this function's allowed connections: []" for lack of visibility, not a real
    // access violation.
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
            mockLongPolling,
            FIXTURE_ROOT,
            getMockLogger(),
        );

        // The connection-ID collector is under test here, not the preview-async round trip
        // (already covered elsewhere) — the request just needs to pass the allowedConnectionIds
        // check, so a minimal reply is enough.
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

    // Coverage for a module mixing a static import with a top-level dynamic import textually
    // between two static ones — exercises dev-server-module-graph.ts resolving each static
    // specifier individually against the AST, independent of node.importedModules's undocumented
    // ordering for mixed static/dynamic imports, so the resolution stays correct by construction
    // regardless of what that ordering happens to be for a given module.
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
            mockLongPolling,
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
