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
import { getVitePlugin, SSR_WARMUP_SETTING } from '@dd/apps-plugin/vite/index';
import { outputFileSync, rmSync } from '@dd/core/helpers/fs';
import type { AuthOptionsWithDefaults } from '@dd/core/types';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import {
    createMockRequest,
    createMockResponse,
    getContextMock,
    getMockLogger,
} from '@dd/tests/_jest/helpers/mocks';
import nock from 'nock';
import path from 'path';
import { build, createServer, loadEnv, type Plugin, type ViteDevServer } from 'vite';

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

// Also read by the real configureServer hook below, which without auth only warns and leaves both
// action endpoints unavailable.
process.env.DD_API_KEY = 'test-api-key';
process.env.DD_APP_KEY = 'test-app-key';
const testApiKeyRequest = getAuthenticatedRequest();

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

const previewRuntimeContext = {
    Source: {
        initiator: { id: 'preview-initiator', orgId: 'preview-org' },
        runAsUser: { id: 'preview-run-as', orgId: 'preview-org' },
    },
};

function mockRuntimeContextHydration() {
    nock('https://api.datadoghq.com', {
        reqheaders: {
            'DD-API-KEY': 'test-api-key',
            'DD-APPLICATION-KEY': 'test-app-key',
        },
    })
        .post('/api/v2/app-builder/queries/preview-async', (body) => {
            const fqn = (
                body as {
                    data?: {
                        attributes?: {
                            query?: { properties?: { spec?: { fqn?: unknown } } };
                        };
                    };
                }
            ).data?.attributes?.query?.properties?.spec?.fqn;
            return fqn === 'com.datadoghq.datatransformation.jsFunctionWithActions';
        })
        .reply(200, { data: { id: 'runtime-context-receipt' } })
        .get('/api/v2/app-builder/queries/execution-long-polling/runtime-context-receipt')
        .reply(200, {
            data: {
                attributes: {
                    done: true,
                    outputs: { data: previewRuntimeContext },
                },
            },
        });
}

describe('Dev Server Middleware — real end-to-end local execution', () => {
    let server: ViteDevServer;

    beforeAll(async () => {
        const appsPlugin: Plugin = {
            name: 'dd-apps-test',
            ...getVitePlugin({
                bundler: { build, loadEnv },
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

    beforeEach(() => {
        mockRuntimeContextHydration();
    });

    afterEach(() => {
        nock.cleanAll();
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
            'development',
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
                executionUser: { id: 'preview-run-as', orgId: 'preview-org' },
                initiatingUser: { id: 'preview-initiator', orgId: 'preview-org' },
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
            'development',
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
            'development',
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
            'development',
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
            'development',
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
            'development',
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

// Uses its own dev server rooted in a temp dir, since writing files under the shared fixtures tree
// would race other test files that copy that whole tree in parallel.
const FAKE_SDK_NAME = 'dd-fake-stateful-sdk';

describe('Dev Server Middleware — editing files between local executions', () => {
    let editRoot: string | undefined;
    let editServer: ViteDevServer;

    beforeAll(async () => {
        process.env.DD_API_KEY = 'test-api-key';
        process.env.DD_APP_KEY = 'test-app-key';
        const seed = `apps-edit-then-execute-${process.pid}`;
        const root = getTempWorkingDir(seed);
        editRoot = root;

        const context = getContextMock({ buildRoot: root });
        const appsPlugin: Plugin = {
            name: 'dd-apps-test',
            ...getVitePlugin({
                bundler: { build, loadEnv },
                context,
                options: { include: [], longPolling: mockLongPolling },
            }),
        };
        editServer = await createServer({
            configFile: false,
            root,
            logLevel: 'silent',
            // Each edit is signaled by the test itself; a late real watcher event could
            // invalidate a module on its own and let a regression pass.
            server: {
                middlewareMode: true,
                hmr: false,
                watch: { ignored: ['**/*'] },
                // Asks for SSR import warmup, which the apps plugin turns off for local execution.
                preTransformRequests: true,
            },
            plugins: [appsPlugin],
            optimizeDeps: { noDiscovery: true },
            // Bundled into the SSR graph like the real SDKs, so its evaluation can be cached or re-run.
            ssr: { noExternal: [FAKE_SDK_NAME] },
        });
    });

    afterAll(async () => {
        await editServer?.close();
        if (editRoot) {
            rmSync(editRoot);
        }
    });

    beforeEach(() => {
        mockRuntimeContextHydration();
    });

    afterEach(() => {
        nock.cleanAll();
    });

    const invalidationTimeOf = (file: string) => {
        const nodes = editServer.environments.ssr.moduleGraph.getModulesByFile(file) ?? new Set();
        const times = [...nodes].map((node) =>
            Math.max(node.lastInvalidationTimestamp, node.lastHMRTimestamp),
        );
        return Math.max(0, ...times);
    };

    const waitUntil = async (
        condition: () => boolean,
        message: string,
        deadline = Date.now() + 5000,
    ): Promise<void> => {
        if (condition()) {
            return;
        }
        if (Date.now() > deadline) {
            throw new Error(message);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        await waitUntil(condition, message, deadline);
    };

    // Signals the edit the way the real watcher would, then waits for Vite to invalidate it.
    const editFile = async (file: string, contents: string) => {
        const before = invalidationTimeOf(file);
        outputFileSync(file, contents);
        editServer.watcher.emit('change', file);
        await waitUntil(() => invalidationTimeOf(file) > before, `Vite never invalidated ${file}`);
    };

    const execute = async (func: BackendFunction) => {
        const functionName = encodeQueryName(func);
        const req = createMockRequest('/__dd/executeAction', { functionName, args: [] });
        const res = createMockResponse();
        const next = jest.fn();
        editServer.middlewares(req, res, next);
        await res.done;
        const rawBody = res.getBody();
        return { statusCode: res.statusCode, body: JSON.parse(rawBody) };
    };

    const backendFunctionAt = (file: string, name: string): BackendFunction => {
        const relativeFile = path.relative(editServer.config.root, file);
        return {
            relativePath: relativeFile.replace(/\.backend\.ts$/, ''),
            name,
            absolutePath: file,
            allowedConnectionIds: [],
        };
    };

    test('Should run the edited code on the next execution after a backend file changes', async () => {
        const file = path.join(editServer.config.root, 'editedEntry.backend.ts');
        const func = backendFunctionAt(file, 'readVersion');
        const sourceFor = (version: string) =>
            `export async function readVersion() { return '${version}'; }\n`;
        const initialSource = sourceFor('v1');
        outputFileSync(file, initialSource);
        // Registers the function the way a frontend import of the generated client would.
        await editServer.ssrLoadModule(file);

        const first = await execute(func);
        expect(first.statusCode).toBe(200);
        expect(first.body).toEqual({ success: true, result: { data: 'v1' } });

        const editedSource = sourceFor('v2');
        await editFile(file, editedSource);
        mockRuntimeContextHydration();
        const second = await execute(func);
        expect(second.statusCode).toBe(200);
        expect(second.body).toEqual({ success: true, result: { data: 'v2' } });
    }, 30000);

    test('Should run the edited code on the next execution after a module the backend file imports changes', async () => {
        const file = path.join(editServer.config.root, 'editedDependencyEntry.backend.ts');
        const dependencyFile = path.join(editServer.config.root, 'editedDependency.ts');
        const func = backendFunctionAt(file, 'readDependencyVersion');
        const dependencySourceFor = (version: string) => `export const version = '${version}';\n`;
        const initialDependencySource = dependencySourceFor('v1');
        outputFileSync(dependencyFile, initialDependencySource);
        outputFileSync(
            file,
            "import { version } from './editedDependency';\nexport async function readDependencyVersion() { return version; }\n",
        );
        await editServer.ssrLoadModule(file);

        const first = await execute(func);
        expect(first.statusCode).toBe(200);
        expect(first.body).toEqual({ success: true, result: { data: 'v1' } });

        const editedDependencySource = dependencySourceFor('v2');
        await editFile(dependencyFile, editedDependencySource);
        mockRuntimeContextHydration();
        const second = await execute(func);
        expect(second.statusCode).toBe(200);
        expect(second.body).toEqual({ success: true, result: { data: 'v2' } });
    }, 30000);

    test('Should turn off SSR import warmup without changing the client environment', () => {
        const ssrWarmup = editServer.environments.ssr.config.dev.preTransformRequests;
        const clientWarmup = editServer.environments.client.config.dev.preTransformRequests;

        expect(ssrWarmup).toBe(false);
        expect(clientWarmup).toBe(true);
    });

    test('Should run the edited code in every branch on the next execution after a shared dependency changes', async () => {
        const root = editServer.config.root;
        const file = path.join(root, 'branchingEntry.backend.ts');
        const dependencyFile = path.join(root, 'sharedDependency.ts');
        const func = backendFunctionAt(file, 'readBranchVersions');
        const branches = ['branchA', 'branchB', 'branchC'];
        const dependencySourceFor = (version: string) => `export const version = '${version}';\n`;
        const initialDependencySource = dependencySourceFor('v1');
        outputFileSync(dependencyFile, initialDependencySource);
        branches.forEach((branch) => {
            const branchFile = path.join(root, `${branch}.ts`);
            const branchSource = `import { version } from './sharedDependency';\nexport const ${branch} = () => version;\n`;
            outputFileSync(branchFile, branchSource);
        });
        const branchImports = branches.map((branch) => `import { ${branch} } from './${branch}';`);
        const branchCalls = branches.map((branch) => `${branch}()`).join(', ');
        const entrySource = `${branchImports.join('\n')}\nexport async function readBranchVersions() { return [${branchCalls}]; }\n`;
        outputFileSync(file, entrySource);
        await editServer.ssrLoadModule(file);
        const versionsInEveryBranch = (version: string) => branches.map(() => version);

        const first = await execute(func);
        expect(first.body).toEqual({
            success: true,
            result: { data: versionsInEveryBranch('v1') },
        });

        const editedDependencySource = dependencySourceFor('v2');
        await editFile(dependencyFile, editedDependencySource);
        mockRuntimeContextHydration();
        const second = await execute(func);
        expect(second.body).toEqual({
            success: true,
            result: { data: versionsInEveryBranch('v2') },
        });
    }, 30000);

    test('Should keep an invalidated package dependency cached, so its state survives an edit', async () => {
        const sdkDir = path.join(editServer.config.root, 'node_modules', FAKE_SDK_NAME);
        const sdkManifest = JSON.stringify({
            name: FAKE_SDK_NAME,
            type: 'module',
            main: 'index.js',
        });
        const sdkManifestPath = path.join(sdkDir, 'package.json');
        const sdkEntryPath = path.join(sdkDir, 'index.js');
        outputFileSync(sdkManifestPath, sdkManifest);
        outputFileSync(
            sdkEntryPath,
            'let calls = 0;\nexport function bump() { calls += 1; return calls; }\n',
        );
        const file = path.join(editServer.config.root, 'sdkEntry.backend.ts');
        const func = backendFunctionAt(file, 'callSdk');
        const sourceFor = (version: string) =>
            `import { bump } from '${FAKE_SDK_NAME}';\nexport async function callSdk() { return ['${version}', bump()]; }\n`;
        const initialSource = sourceFor('v1');
        outputFileSync(file, initialSource);
        await editServer.ssrLoadModule(file);
        const first = await execute(func);
        expect(first.body).toEqual({ success: true, result: { data: ['v1', 1] } });

        const editedSource = sourceFor('v2');
        await editFile(file, editedSource);
        // Invalidates the SDK too, as a tsconfig.json change would.
        editServer.environments.ssr.moduleGraph.invalidateAll();
        mockRuntimeContextHydration();
        const second = await execute(func);

        expect(second.body).toEqual({ success: true, result: { data: ['v2', 2] } });
    }, 30000);

    test('Should keep module state across unchanged executions after an edit', async () => {
        const file = path.join(editServer.config.root, 'countingEntry.backend.ts');
        const func = backendFunctionAt(file, 'countCalls');
        const sourceFor = (start: number) =>
            `let calls = ${start};\nexport async function countCalls() { calls += 1; return calls; }\n`;
        const initialSource = sourceFor(0);
        outputFileSync(file, initialSource);
        await editServer.ssrLoadModule(file);
        const countCalls = async () => {
            mockRuntimeContextHydration();
            const { body } = await execute(func);
            return body.result.data;
        };
        await countCalls();

        const editedStart = 100;
        const editedSource = sourceFor(editedStart);
        await editFile(file, editedSource);
        const afterEdit = [await countCalls(), await countCalls(), await countCalls()];
        expect(afterEdit).toEqual([editedStart + 1, editedStart + 2, editedStart + 3]);
    }, 30000);
});

describe('Dev Server Middleware — SSR import warmup warnings', () => {
    const reenableSsrWarmup: Plugin = {
        name: 'dd-test-reenable-ssr-warmup',
        configEnvironment(name) {
            return name === 'ssr' ? { dev: { preTransformRequests: true } } : undefined;
        },
    };

    const laterServerWarmup: Plugin = {
        name: 'dd-test-later-server-warmup',
        config: () => ({ server: { preTransformRequests: true } }),
    };

    test.each([
        {
            description: 'another plugin turns it back on',
            otherPlugins: [reenableSsrWarmup],
            ssrWarmup: true,
            expectedWarnings: 1,
        },
        {
            description: 'nothing turns it back on',
            otherPlugins: [],
            ssrWarmup: false,
            expectedWarnings: 0,
        },
        {
            description: "a later plugin's config asks for server.preTransformRequests",
            otherPlugins: [laterServerWarmup],
            ssrWarmup: false,
            expectedWarnings: 1,
        },
    ])(
        'Should log $expectedWarnings SSR import warmup warning(s) when $description',
        async ({ otherPlugins, ssrWarmup, expectedWarnings }) => {
            const seed = `apps-ssr-warmup-${process.pid}-${ssrWarmup}-${expectedWarnings}`;
            const root = getTempWorkingDir(seed);
            const warn = jest.fn();
            const logger = getMockLogger({ warn });
            const context = getContextMock({ buildRoot: root, getLogger: () => logger });
            const appsPlugin: Plugin = {
                name: 'dd-apps-test',
                ...getVitePlugin({
                    bundler: { build, loadEnv },
                    context,
                    options: { include: [], longPolling: mockLongPolling },
                }),
            };
            const server = await createServer({
                configFile: false,
                root,
                logLevel: 'silent',
                server: { middlewareMode: true, hmr: false, watch: { ignored: ['**/*'] } },
                plugins: [appsPlugin, ...otherPlugins],
                optimizeDeps: { noDiscovery: true },
            });

            try {
                const resolvedSsrWarmup = server.environments.ssr.config.dev.preTransformRequests;
                const warmupWarnings = warn.mock.calls.filter(([text]) =>
                    String(text).includes(SSR_WARMUP_SETTING),
                );
                expect(resolvedSsrWarmup).toBe(ssrWarmup);
                expect(warmupWarnings).toHaveLength(expectedWarnings);
            } finally {
                await server.close();
                rmSync(root);
            }
        },
        30000,
    );
});
