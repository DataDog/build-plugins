// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Real coverage for local execution's module resolution: a real Vite dev server runs against
 * the `apps_backend_project` fixture with no mocked `viteBuild`/`loadModule`/`this.resolve()`,
 * so `resolveId`'s suffix propagation and the connection-ID collector exercise Vite's actual
 * SSR transform output, not a hand-crafted stand-in.
 */

import { getAuthenticatedRequest } from '@dd/apps-plugin/auth';
import { collectModuleGraphFromServer } from '@dd/apps-plugin/vite/dev-server-module-graph';
import { createDevServerMiddleware } from '@dd/apps-plugin/vite/dev-server';
import { getVitePlugin } from '@dd/apps-plugin/vite/index';
import type { AuthOptionsWithDefaults } from '@dd/core/types';
import { cleanEnv } from '@dd/tests/_jest/helpers/env';
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

// getAuthenticatedRequest reads API-key auth from the environment (see
// setupAfterEnv's cleanEnv, which strips these after collection).
const restoreModuleEnv = cleanEnv();
process.env.DD_API_KEY = 'test-api-key';
process.env.DD_APP_KEY = 'test-app-key';
const testApiKeyRequest = getAuthenticatedRequest();

afterAll(() => {
    restoreModuleEnv();
});

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
        // The real configureServer hook (via getVitePlugin below) calls getAuthenticatedRequest()
        // itself — set after setupAfterEnv's own beforeAll (which runs first and strips these via
        // cleanEnv) so the real dev server actually resolves auth instead of warning and disabling it.
        process.env.DD_API_KEY = 'test-api-key';
        process.env.DD_APP_KEY = 'test-app-key';

        const appsPlugin: Plugin = {
            name: 'dd-apps-test',
            ...getVitePlugin({
                bundler: { build },
                context: getContextMock({ buildRoot: FIXTURE_ROOT }),
                options: {
                    include: [],
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
            // Local execution never uses the browser pre-bundle step, and the fake
            // @datadog/action-catalog fixture below can trip it up, so disable it.
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
            testApiKeyRequest,
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

    // Covers resolveId's suffix propagation onto nestedImport.backend.ts's static import of
    // getRuntimeUsers.backend.ts — without it, that import would resolve unsuffixed and get
    // swapped for the frontend RPC-proxy stub instead of running for real.
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
            testApiKeyRequest,
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

    // Multi-hop case: viaHelper.backend.ts imports plain helper.ts, which imports
    // getRuntimeUsers.backend.ts. Suffix propagation must follow through helper.ts even
    // though helper.ts itself never gets suffixed.
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
            testApiKeyRequest,
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

    // Every other test bypasses getAllowedConnectionIds' real wiring via
    // createDevServerMiddleware(..., () => [], ...); this one sends the request through
    // server.middlewares — the real stack configureServer installs — to exercise it for real.
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

    // Uses noSdkFunc since every other function here already has a warm moduleGraph node from
    // an earlier test, which would mask this invariant: on a cold entry, Vite only registers
    // the node under its fully-resolved (suffixed) id, not the bare path.
    test('Should compute allowed connection IDs on the very first request for an entry, with no prior priming import', async () => {
        const loadModule = server.ssrLoadModule.bind(server);
        // collectModuleGraphFromServer appends LOCAL_EXECUTION_LOAD_SUFFIX internally, so this
        // closure only handles the bare id — matching vite/index.ts's real wiring.
        const getAllowedConnectionIds = async (entryId: string) =>
            extractConnectionIdsFromModuleGraph(
                entryId,
                await collectModuleGraphFromServer(server, entryId, FIXTURE_ROOT, getMockLogger()),
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
            testApiKeyRequest,
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

    // Vite's SSR transform rewrites imports into `__vite_ssr_import__(...)` calls that
    // collectActionCatalogImports's `ImportDeclaration` search can't parse, so the collector
    // must read each module's original source from disk instead of the transformed output.
    test('Should recognize a connectionId-scoped action-catalog call and allow it, not silently reject it', async () => {
        const loadModule = server.ssrLoadModule.bind(server);
        const getAllowedConnectionIds = async (entryId: string) =>
            extractConnectionIdsFromModuleGraph(
                entryId,
                await collectModuleGraphFromServer(server, entryId, FIXTURE_ROOT, getMockLogger()),
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
            testApiKeyRequest,
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

    // A dynamic import sits between two static ones, so resolution must come from the AST
    // itself rather than node.importedModules's undocumented ordering for mixed imports.
    test('Should recognize a connectionId-scoped action-catalog call even when a top-level dynamic import sits between two static imports', async () => {
        const loadModule = server.ssrLoadModule.bind(server);
        const getAllowedConnectionIds = async (entryId: string) =>
            extractConnectionIdsFromModuleGraph(
                entryId,
                await collectModuleGraphFromServer(server, entryId, FIXTURE_ROOT, getMockLogger()),
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
            testApiKeyRequest,
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
