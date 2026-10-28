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
import { buildBackendFunctions } from '@dd/apps-plugin/vite/build-backend-functions';
import { collectModuleGraphFromServer } from '@dd/apps-plugin/vite/dev-server-module-graph';
import { createViteHostCheck } from '@dd/apps-plugin/vite/dev-server-request-guard';
import {
    createDevServerMiddleware,
    DEBUG_BUNDLE_ROUTE,
    EXECUTE_ACTION_ROUTE,
} from '@dd/apps-plugin/vite/dev-server';
import { DEV_CLIENT_SRC, getVitePlugin, SSR_WARMUP_SETTING } from '@dd/apps-plugin/vite/index';
import * as fsHelpers from '@dd/core/helpers/fs';
import { outputFileSync, readFileSync, rmSync } from '@dd/core/helpers/fs';
import type { AuthOptionsWithDefaults } from '@dd/core/types';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import {
    createMockRequest,
    createMockResponse,
    getContextMock,
    getMockLogger,
} from '@dd/tests/_jest/helpers/mocks';
import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import nock from 'nock';
import path from 'path';
import { parseAst } from 'rollup/parseAst';
import {
    build,
    createServer,
    defaultServerConditions,
    type Plugin,
    type ViteDevServer,
} from 'vite';

import { extractConnectionIdsFromModuleGraph } from '../backend/ast-parsing/extract-connection-ids-from-module-graph';
import { encodeQueryName } from '../backend/encodeQueryName';
import { DEBUG_BUNDLE_PATH } from '../backend/protocol';
import type { BackendFunction } from '../backend/types';
import { DEV_VERIFY_MODE } from '../constants';

import {
    buildLocalExecutionChild,
    removeLocalExecutionChild,
} from './local-execution-process.fixtures';
import { createChildProcessExecutor, resolveViteModuleRunner } from './local-execution-process';

// Jest compiles loadViteParseAst's dynamic import into a `require`, which gets Vite's CJS
// entry and no `parseAst`; the published build keeps the real import.
jest.mock('@dd/apps-plugin/vite/vite-parse-ast', () => ({
    loadViteParseAst: async () => parseAst,
}));

let mockChildEntryPath = '';
jest.mock('@dd/apps-plugin/vite/local-execution-child-path', () => ({
    getLocalExecutionChildPath: () => mockChildEntryPath,
}));

beforeAll(async () => {
    mockChildEntryPath = await buildLocalExecutionChild();
});

afterAll(() => {
    removeLocalExecutionChild();
});

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

const makeChildExecutor = (devServer: ViteDevServer) => {
    const moduleRunnerPath = resolveViteModuleRunner(FIXTURE_ROOT);
    return createChildProcessExecutor({
        invokeChannel: devServer.environments.ssr.hot,
        projectRoot: FIXTURE_ROOT,
        childEntryPath: mockChildEntryPath,
        moduleRunnerPath,
        log: getMockLogger(),
        writeOutput: () => {},
    });
};

describe('Dev Server Middleware — real end-to-end local execution', () => {
    let server: ViteDevServer;

    beforeAll(async () => {
        const appsPlugin: Plugin = {
            name: 'dd-apps-test',
            ...getVitePlugin({
                bundler: { build, defaultServerConditions },
                context: getContextMock({ buildRoot: FIXTURE_ROOT }),
                options: {
                    include: [],
                    tags: [],
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
        const isHostAllowed = createViteHostCheck(server.config);
        const middleware = createDevServerMiddleware(
            build,
            () => [getRuntimeUsersFunc],
            async () => [],
            auth,
            testApiKeyRequest,
            mockLongPolling,
            FIXTURE_ROOT,
            getMockLogger(),
            'development',
            isHostAllowed,
            defaultServerConditions,
            makeChildExecutor(server),
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
        const isHostAllowed = createViteHostCheck(server.config);
        const middleware = createDevServerMiddleware(
            build,
            () => [nestedImportFunc],
            async () => [],
            auth,
            testApiKeyRequest,
            mockLongPolling,
            FIXTURE_ROOT,
            getMockLogger(),
            'development',
            isHostAllowed,
            defaultServerConditions,
            makeChildExecutor(server),
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
        const isHostAllowed = createViteHostCheck(server.config);
        const middleware = createDevServerMiddleware(
            build,
            () => [viaHelperFunc],
            async () => [],
            auth,
            testApiKeyRequest,
            mockLongPolling,
            FIXTURE_ROOT,
            getMockLogger(),
            'development',
            isHostAllowed,
            defaultServerConditions,
            makeChildExecutor(server),
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

    test('Should run each call through the real configureServer-installed middleware in its own fresh child process', async () => {
        const countCallsFunc: BackendFunction = {
            relativePath: 'childState',
            name: 'countCalls',
            absolutePath: path.join(FIXTURE_ROOT, 'childState.backend.ts'),
            allowedConnectionIds: [],
        };
        await server.ssrLoadModule(countCallsFunc.absolutePath);

        const results = [];
        for (let i = 0; i < 2; i++) {
            // beforeEach mocks the first call's hydration.
            if (i > 0) {
                mockRuntimeContextHydration();
            }
            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(countCallsFunc),
                args: [0],
            });
            const res = createMockResponse();
            server.middlewares(req, res, jest.fn());
            // eslint-disable-next-line no-await-in-loop
            await res.done;
            expect(res.statusCode).toBe(200);
            results.push(JSON.parse(res.getBody()).result.data);
        }

        expect(results).toEqual([
            expect.objectContaining({ calls: 1, globalCalls: 1 }),
            expect.objectContaining({ calls: 1, globalCalls: 1 }),
        ]);
        expect(results[0].pid).not.toBe(process.pid);
        expect(results[0].pid).not.toBe(results[1].pid);
    }, 30000);

    // Uses noSdkFunc since every other function here already has a warm moduleGraph node from
    // an earlier test, which would mask this invariant: on a cold entry, Vite only registers
    // the node under its fully-resolved (suffixed) id, not the bare path.
    test('Should compute allowed connection IDs on the very first request for an entry, with no prior priming import', async () => {
        // collectModuleGraphFromServer appends LOCAL_EXECUTION_LOAD_SUFFIX internally, so this
        // closure only handles the bare id — matching vite/index.ts's real wiring.
        const getAllowedConnectionIds = async (entryId: string) => {
            const log = getMockLogger();
            const moduleGraph = await collectModuleGraphFromServer(
                server,
                entryId,
                FIXTURE_ROOT,
                log,
                parseAst,
            );
            return extractConnectionIdsFromModuleGraph(entryId, moduleGraph, FIXTURE_ROOT);
        };

        const auth: AuthOptionsWithDefaults = {
            apiKey: 'test-api-key',
            appKey: 'test-app-key',
            site: 'datadoghq.com',
        };
        const isHostAllowed = createViteHostCheck(server.config);
        const middleware = createDevServerMiddleware(
            build,
            () => [noSdkFunc],
            getAllowedConnectionIds,
            auth,
            testApiKeyRequest,
            mockLongPolling,
            FIXTURE_ROOT,
            getMockLogger(),
            'development',
            isHostAllowed,
            defaultServerConditions,
            makeChildExecutor(server),
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
        const getAllowedConnectionIds = async (entryId: string) => {
            const log = getMockLogger();
            const moduleGraph = await collectModuleGraphFromServer(
                server,
                entryId,
                FIXTURE_ROOT,
                log,
                parseAst,
            );
            return extractConnectionIdsFromModuleGraph(entryId, moduleGraph, FIXTURE_ROOT);
        };

        const auth: AuthOptionsWithDefaults = {
            apiKey: 'test-api-key',
            appKey: 'test-app-key',
            site: 'datadoghq.com',
        };
        const isHostAllowed = createViteHostCheck(server.config);
        const middleware = createDevServerMiddleware(
            build,
            () => [actionCatalogCallFunc],
            getAllowedConnectionIds,
            auth,
            testApiKeyRequest,
            mockLongPolling,
            FIXTURE_ROOT,
            getMockLogger(),
            'development',
            isHostAllowed,
            defaultServerConditions,
            makeChildExecutor(server),
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

    test('Should return a real bundle with the connection IDs it uses from /__dd/debugBundle as JSON', async () => {
        const log = getMockLogger();
        const middleware = createDevServerMiddleware(
            build,
            () => [actionCatalogCallFunc],
            async () => [],
            { site: 'datadoghq.com' },
            undefined,
            mockLongPolling,
            FIXTURE_ROOT,
            log,
            'development',
            createViteHostCheck(server.config),
            defaultServerConditions,
        );

        const functionName = encodeQueryName(actionCatalogCallFunc);
        const req = createMockRequest(
            DEBUG_BUNDLE_PATH,
            { functionName },
            { accept: 'application/json' },
        );
        const res = createMockResponse();

        const next = jest.fn();
        middleware(req, res, next);
        await res.done;

        expect(res.statusCode).toBe(200);
        const rawBody = res.getBody();
        const body = JSON.parse(rawBody);
        expect(body.allowedConnectionIds).toEqual(['conn-1']);
        expect(body.code).toContain('conn-1');
    }, 30000);

    // A dynamic import sits between two static ones, so resolution must come from the AST
    // itself rather than node.importedModules's undocumented ordering for mixed imports.
    test('Should recognize a connectionId-scoped action-catalog call even when a top-level dynamic import sits between two static imports', async () => {
        const getAllowedConnectionIds = async (entryId: string) => {
            const log = getMockLogger();
            const moduleGraph = await collectModuleGraphFromServer(
                server,
                entryId,
                FIXTURE_ROOT,
                log,
                parseAst,
            );
            return extractConnectionIdsFromModuleGraph(entryId, moduleGraph, FIXTURE_ROOT);
        };

        const auth: AuthOptionsWithDefaults = {
            apiKey: 'test-api-key',
            appKey: 'test-app-key',
            site: 'datadoghq.com',
        };
        const isHostAllowed = createViteHostCheck(server.config);
        const middleware = createDevServerMiddleware(
            build,
            () => [mixedImportsFunc],
            getAllowedConnectionIds,
            auth,
            testApiKeyRequest,
            mockLongPolling,
            FIXTURE_ROOT,
            getMockLogger(),
            'development',
            isHostAllowed,
            defaultServerConditions,
            makeChildExecutor(server),
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

describe('Dev Server Middleware — dev:verify bundles', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
        nock.cleanAll();
        if (originalNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = originalNodeEnv;
        }
    });

    // Each build runs under the NODE_ENV its real process has: `vite build` sets production, a dev
    // server development.
    async function buildUploadAndVerify(workingDir: string, func: BackendFunction) {
        const log = getMockLogger();
        process.env.NODE_ENV = 'production';
        const upload = await buildBackendFunctions(build, [func], workingDir, log);
        let uploadCode: string;
        try {
            const [uploadPath] = [...upload.outputs.values()];
            uploadCode = readFileSync(uploadPath);
        } finally {
            rmSync(upload.outDir);
        }

        process.env.NODE_ENV = 'development';
        const submitted: { script?: unknown } = {};
        const apiScope = nock('https://api.datadoghq.com')
            .post('/api/v2/app-builder/queries/preview-async', (body) => {
                submitted.script = body.data.attributes.query.properties.spec.inputs.script;
                return true;
            })
            .reply(200, { data: { id: 'receipt-verify-bundle' } })
            .get('/api/v2/app-builder/queries/execution-long-polling/receipt-verify-bundle')
            .reply(200, { data: { attributes: { done: true, outputs: { data: { ok: true } } } } });
        const isHostAllowed = createViteHostCheck({ server: { allowedHosts: [] }, preview: {} });
        const middleware = createDevServerMiddleware(
            build,
            () => [func],
            async () => [],
            { site: 'datadoghq.com' } satisfies AuthOptionsWithDefaults,
            testApiKeyRequest,
            mockLongPolling,
            workingDir,
            log,
            DEV_VERIFY_MODE,
            isHostAllowed,
            defaultServerConditions,
        );
        const functionName = encodeQueryName(func);
        const req = createMockRequest(EXECUTE_ACTION_ROUTE, { functionName, args: ['QA'] });
        const res = createMockResponse();
        const next = jest.fn();
        middleware(req, res, next);
        await res.done;

        const apiDone = apiScope.isDone();
        return {
            uploadCode,
            submittedScript: submitted.script,
            statusCode: res.statusCode,
            apiDone,
        };
    }

    test('Should submit the minified bytes an upload writes', async () => {
        const seed = `dev-verify-minify-${Date.now()}`;
        const workingDir = getTempWorkingDir(seed);
        try {
            const absolutePath = `${workingDir}/src/names.backend.ts`;
            outputFileSync(
                absolutePath,
                `
            class BackendValidationError extends Error {}
            const readableHelper = (value: string) => {
                if (!value) throw new BackendValidationError('missing value');
                return value;
            };
            export async function readableBackendFunction(value: string) {
                return readableHelper(value);
            }
        `,
            );
            const namesFunc: BackendFunction = {
                relativePath: 'src/names',
                name: 'readableBackendFunction',
                absolutePath,
                allowedConnectionIds: [],
            };

            const result = await buildUploadAndVerify(workingDir, namesFunc);

            // Minified, with names kept: the unminified output spans many lines.
            const uploadLineCount = result.uploadCode.trim().split('\n').length;
            expect(result.statusCode).toBe(200);
            expect(result.apiDone).toBe(true);
            expect(result.submittedScript).toBe(result.uploadCode);
            expect(uploadLineCount).toBeLessThan(5);
            expect(result.uploadCode).toContain('"BackendValidationError"');
        } finally {
            rmSync(workingDir);
        }
    }, 30000);

    test('Should submit the production bytes an upload writes, under the dev server NODE_ENV', async () => {
        const seed = `dev-verify-production-${Date.now()}`;
        const workingDir = getTempWorkingDir(seed);
        try {
            const packageDir = `${workingDir}/node_modules/dd-conditional-flavor`;
            const packageJson = {
                name: 'dd-conditional-flavor',
                type: 'module',
                exports: {
                    '.': {
                        development: './development.js',
                        production: './production.js',
                        default: './production.js',
                    },
                },
            };
            const packageJsonText = JSON.stringify(packageJson);
            outputFileSync(`${packageDir}/package.json`, packageJsonText);
            outputFileSync(`${packageDir}/development.js`, "export const flavor = 'dev-export';");
            outputFileSync(`${packageDir}/production.js`, "export const flavor = 'prod-export';");
            const absolutePath = `${workingDir}/src/flavors.backend.ts`;
            outputFileSync(
                absolutePath,
                `
            import { flavor } from 'dd-conditional-flavor';
            export async function flavors() {
                const viteFlavor = import.meta.env.DEV ? 'vite-dev' : 'vite-prod';
                const prodFlavor = import.meta.env.PROD ? 'prod-true' : 'prod-false';
                const nodeFlavor = process.env.NODE_ENV === 'production' ? 'node-prod' : 'node-dev';
                return [flavor, viteFlavor, prodFlavor, nodeFlavor, import.meta.env.MODE];
            }
        `,
            );
            const flavorsFunc: BackendFunction = {
                relativePath: 'src/flavors',
                name: 'flavors',
                absolutePath,
                allowedConnectionIds: [],
            };

            const result = await buildUploadAndVerify(workingDir, flavorsFunc);

            expect(result.statusCode).toBe(200);
            expect(result.apiDone).toBe(true);
            expect(result.uploadCode).toContain('prod-export');
            expect(result.uploadCode).not.toContain('dev-export');
            expect(result.submittedScript).toBe(result.uploadCode);
        } finally {
            rmSync(workingDir);
        }
    }, 30000);

    test('Should submit the production JSX transform an upload writes, under the dev server NODE_ENV', async () => {
        const seed = `dev-verify-jsx-${Date.now()}`;
        const workingDir = getTempWorkingDir(seed);
        try {
            const reactDir = `${workingDir}/node_modules/react`;
            const reactPackage = {
                name: 'react',
                type: 'module',
                exports: {
                    './jsx-runtime': './jsx-runtime.js',
                    './jsx-dev-runtime': './jsx-dev-runtime.js',
                },
            };
            const reactPackageText = JSON.stringify(reactPackage);
            outputFileSync(`${reactDir}/package.json`, reactPackageText);
            outputFileSync(`${reactDir}/jsx-runtime.js`, 'export const jsx = (type) => type;');
            outputFileSync(
                `${reactDir}/jsx-dev-runtime.js`,
                'export const jsxDEV = (type) => type;',
            );
            const tsconfig = { compilerOptions: { jsx: 'react-jsx' } };
            const tsconfigText = JSON.stringify(tsconfig);
            outputFileSync(`${workingDir}/tsconfig.json`, tsconfigText);
            const absolutePath = `${workingDir}/src/markup.backend.tsx`;
            outputFileSync(absolutePath, 'export async function markup() { return <section />; }');
            const markupFunc: BackendFunction = {
                relativePath: 'src/markup',
                name: 'markup',
                absolutePath,
                allowedConnectionIds: [],
            };

            const result = await buildUploadAndVerify(workingDir, markupFunc);

            expect(result.statusCode).toBe(200);
            expect(result.uploadCode).not.toContain('jsxDEV');
            expect(result.submittedScript).toBe(result.uploadCode);
        } finally {
            rmSync(workingDir);
        }
    }, 30000);
});

// Uses its own dev server rooted in a temp dir, since writing files under the shared fixtures tree
// would race other test files that copy that whole tree in parallel.

describe('Dev client module', () => {
    const startDevServer = async (base: string, extraPlugins: Plugin[] = []) => {
        const appsPlugin: Plugin = {
            name: 'dd-apps-test',
            enforce: 'post',
            ...getVitePlugin({
                bundler: { build, defaultServerConditions },
                context: getContextMock({ buildRoot: FIXTURE_ROOT }),
                options: { include: [], longPolling: mockLongPolling },
            }),
        };
        const devServer = await createServer({
            configFile: false,
            root: FIXTURE_ROOT,
            base,
            logLevel: 'silent',
            server: { middlewareMode: true, hmr: false },
            plugins: [appsPlugin, ...extraPlugins],
            optimizeDeps: { noDiscovery: true },
        });
        const httpServer = http.createServer(devServer.middlewares);
        await new Promise<void>((resolve) => {
            httpServer.listen(0, '127.0.0.1', resolve);
        });
        const address = httpServer.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        const close = async () => {
            await new Promise((resolve) => {
                httpServer.close(resolve);
            });
            await devServer.close();
        };
        return { devServer, origin: `http://127.0.0.1:${port}`, close };
    };

    beforeEach(() => {
        nock.enableNetConnect('127.0.0.1');
    });

    afterEach(() => {
        nock.disableNetConnect();
        jest.restoreAllMocks();
    });

    const bases = [
        { description: 'at the root', base: '/' },
        { description: 'under a base path', base: '/myapp/' },
    ];

    test.each(bases)(
        'Should serve the dev client its page links to $description',
        async ({ base }) => {
            jest.spyOn(fsHelpers, 'readFile').mockResolvedValue(
                'globalThis.devClientLoaded = true;',
            );
            const loadsEveryId: Plugin = {
                name: 'loads-every-id',
                load: () => 'export const unexpected = true;',
            };
            const { devServer, origin, close } = await startDevServer(base, [loadsEveryId]);

            try {
                const html = await devServer.transformIndexHtml(
                    '/index.html',
                    '<html><head></head><body></body></html>',
                );
                const devClientSrc = path.posix.join(base, DEV_CLIENT_SRC);
                const devClientUrl = `${origin}${devClientSrc}`;
                const response = await fetch(devClientUrl);
                const devClient = await response.text();

                expect(html).toContain(`<script type="module" src="${devClientSrc}"></script>`);
                expect(response.status).toBe(200);
                expect(devClient).toContain('devClientLoaded');
            } finally {
                await close();
            }
        },
        30000,
    );
});

describe('Dev Server Middleware — editing files between local executions', () => {
    let editRoot: string | undefined;
    let editServer: ViteDevServer;

    beforeAll(async () => {
        process.env.DD_API_KEY = 'test-api-key';
        process.env.DD_APP_KEY = 'test-app-key';
        const seed = `apps-edit-then-execute-${process.pid}`;
        const root = getTempWorkingDir(seed);
        editRoot = root;
        // A call's process loads modules through the project's own Vite module runner.
        const viteDir = path.dirname(require.resolve('vite/package.json'));
        fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
        fs.symlinkSync(viteDir, path.join(root, 'node_modules', 'vite'), 'dir');

        const context = getContextMock({ buildRoot: root });
        const appsPlugin: Plugin = {
            name: 'dd-apps-test',
            ...getVitePlugin({
                bundler: { build, defaultServerConditions },
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
                    bundler: { build, defaultServerConditions },
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

describe('Dev Server Middleware — request origin and host checks over real HTTP', () => {
    const VITE_ADDITIONAL_ALLOWED_HOSTS_ENV = '__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS';
    const previewSuffix = '.preview.example';
    const configuredOriginHost = 'origin.internal';
    let server: ViteDevServer;
    let port: number;

    function request(
        method: string,
        urlPath: string,
        headers: http.OutgoingHttpHeaders,
        body?: string,
    ): Promise<{ status: number; body: string }> {
        return new Promise((resolve, reject) => {
            const req = http.request(
                { host: '127.0.0.1', port, method, path: urlPath, headers },
                (res) => {
                    let responseBody = '';
                    res.on('data', (chunk: Buffer) => {
                        responseBody += chunk.toString();
                    });
                    res.on('end', () =>
                        resolve({ status: res.statusCode ?? 0, body: responseBody }),
                    );
                },
            );
            req.on('error', reject);
            req.end(body);
        });
    }

    const functionName = encodeQueryName(getRuntimeUsersFunc);
    const debugBundleBody = JSON.stringify({ functionName });
    const executeActionBody = JSON.stringify({ functionName, args: [] });
    const unknownFunctionBody = JSON.stringify({ functionName: 'unknown' });
    const postDebugBundle = (headers: http.OutgoingHttpHeaders) =>
        request('POST', DEBUG_BUNDLE_ROUTE, headers, debugBundleBody);

    beforeAll(async () => {
        const context = getContextMock({ buildRoot: FIXTURE_ROOT });
        const appsPlugin: Plugin = {
            name: 'dd-apps-test',
            ...getVitePlugin({
                bundler: { build, defaultServerConditions },
                context,
                options: { include: [], tags: [], longPolling: mockLongPolling },
            }),
        };

        // Hosted preview environments set this so Vite answers to their proxy's host.
        const previousAllowedHosts = process.env[VITE_ADDITIONAL_ALLOWED_HOSTS_ENV];
        process.env[VITE_ADDITIONAL_ALLOWED_HOSTS_ENV] = previewSuffix;
        try {
            server = await createServer({
                configFile: false,
                root: FIXTURE_ROOT,
                logLevel: 'silent',
                server: {
                    host: '127.0.0.1',
                    port: 0,
                    hmr: false,
                    origin: `http://${configuredOriginHost}`,
                },
                plugins: [appsPlugin],
                optimizeDeps: { noDiscovery: true },
            });
        } finally {
            if (previousAllowedHosts === undefined) {
                delete process.env[VITE_ADDITIONAL_ALLOWED_HOSTS_ENV];
            } else {
                process.env[VITE_ADDITIONAL_ALLOWED_HOSTS_ENV] = previousAllowedHosts;
            }
        }
        await server.listen();
        const address = server.httpServer?.address();
        if (!address || typeof address === 'string') {
            throw new Error('Expected the dev server to listen on a TCP port');
        }
        port = address.port;
        await server.ssrLoadModule(getRuntimeUsersFunc.absolutePath);
        nock.enableNetConnect(`127.0.0.1:${port}`);
    }, 30000);

    afterAll(async () => {
        nock.disableNetConnect();
        await server?.close();
    });

    test('Should serve a same-origin JSON request on localhost', async () => {
        const response = await postDebugBundle({
            host: `localhost:${port}`,
            origin: `http://localhost:${port}`,
            'content-type': 'application/json',
        });

        expect(response.status).toBe(200);
    }, 30000);

    test('Should serve a request proxied under an allowed preview proxy host', async () => {
        const previewHost = `app-${port}${previewSuffix}`;
        const response = await postDebugBundle({
            host: previewHost,
            origin: `https://${previewHost}`,
            'content-type': 'application/json',
        });

        expect(response.status).toBe(200);
    }, 30000);

    test.each([
        {
            description: 'a cross-site Origin',
            headers: (p: number) => ({
                host: `localhost:${p}`,
                origin: 'https://attacker.example',
                'content-type': 'application/json',
            }),
            expectedStatus: 403,
        },
        {
            description: 'a text/plain body',
            headers: (p: number) => ({
                host: `127.0.0.1:${p}`,
                origin: `http://127.0.0.1:${p}`,
                'content-type': 'text/plain',
            }),
            expectedStatus: 415,
        },
        {
            description: 'a same-origin request under a host Vite would not serve',
            headers: (p: number) => ({
                host: `attacker.example:${p}`,
                origin: `http://attacker.example:${p}`,
                'content-type': 'application/json',
            }),
            expectedStatus: 403,
        },
    ])(
        `Should reject ${EXECUTE_ACTION_ROUTE} with $expectedStatus for $description`,
        async ({ headers, expectedStatus }) => {
            const requestHeaders = headers(port);
            const response = await request(
                'POST',
                EXECUTE_ACTION_ROUTE,
                requestHeaders,
                executeActionBody,
            );

            const body = JSON.parse(response.body);

            expect(response.status).toBe(expectedStatus);
            expect(body.success).toBe(false);
        },
    );

    test.each([
        'localhost',
        '127.0.0.1',
        'app.localhost',
        'attacker.example',
        `app-5173${previewSuffix}`,
        previewSuffix.slice(1),
        `not${previewSuffix.slice(1)}`,
        '[::1]',
        configuredOriginHost,
        `sub.${configuredOriginHost}`,
    ])(
        "Should accept the host %s exactly when Vite's own host check does",
        async (hostname) => {
            const host = `${hostname}:${port}`;
            const viteResponse = await request('GET', '/@vite/client', { host });
            const ownHeaders = {
                host,
                origin: `http://${host}`,
                'content-type': 'application/json',
            };
            const ownResponse = await request(
                'POST',
                DEBUG_BUNDLE_ROUTE,
                ownHeaders,
                unknownFunctionBody,
            );

            expect(ownResponse.status).toBe(viteResponse.status === 403 ? 403 : 404);
        },
        30000,
    );
});

describe('Dev Server Middleware — calls in flight when the dev server closes or restarts', () => {
    const spinForeverFunc: BackendFunction = {
        relativePath: 'childState',
        name: 'spinForever',
        absolutePath: path.join(FIXTURE_ROOT, 'childState.backend.ts'),
        allowedConnectionIds: [],
    };
    const countCallsFunc: BackendFunction = { ...spinForeverFunc, name: 'countCalls' };
    // Under the call timeout, so only the server's own shutdown can end the call this fast.
    const SHUTDOWN_DEADLINE_MS = 5000;

    const createAppServer = () =>
        createServer({
            configFile: false,
            root: FIXTURE_ROOT,
            logLevel: 'silent',
            server: { middlewareMode: true, hmr: false },
            plugins: [
                {
                    name: 'dd-apps-test',
                    ...getVitePlugin({
                        bundler: { build, defaultServerConditions },
                        context: getContextMock({ buildRoot: FIXTURE_ROOT }),
                        options: { include: [], tags: [], longPolling: mockLongPolling },
                    }),
                },
            ],
            optimizeDeps: { noDiscovery: true },
        });

    const callChildPids = () => {
        try {
            const pgrepArgs = ['-P', String(process.pid), '-f', 'local-execution-child'];
            const output = execFileSync('pgrep', pgrepArgs, { encoding: 'utf8' });
            return output.split('\n').filter(Boolean);
        } catch {
            return [];
        }
    };

    const call = (server: ViteDevServer, func: BackendFunction, args: unknown[]) => {
        mockRuntimeContextHydration();
        const req = createMockRequest('/__dd/executeAction', {
            functionName: encodeQueryName(func),
            args,
        });
        const res = createMockResponse();
        server.middlewares(req, res, jest.fn());
        return res;
    };

    const startSpinningCall = async (server: ViteDevServer) => {
        await server.ssrLoadModule(spinForeverFunc.absolutePath);
        const res = call(server, spinForeverFunc, []);
        while (callChildPids().length === 0) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return res;
    };

    const settlesWithin = (done: Promise<void>, timeoutMs: number) => {
        const deadline = new Promise((resolve) => setTimeout(resolve, timeoutMs, 'still running'));
        const settled = done.then(() => 'settled');
        return Promise.race([settled, deadline]);
    };

    afterEach(() => {
        nock.cleanAll();
    });

    test('Should end a call still in flight when its dev server closes', async () => {
        const server = await createAppServer();
        const res = await startSpinningCall(server);

        await server.close();

        await expect(settlesWithin(res.done, SHUTDOWN_DEADLINE_MS)).resolves.toBe('settled');
        expect(res.statusCode).toBe(500);
        expect(callChildPids()).toEqual([]);
    }, 30000);

    test("Should end the old server's calls on restart and keep serving new ones", async () => {
        const server = await createAppServer();
        try {
            const res = await startSpinningCall(server);

            await server.restart();

            await expect(settlesWithin(res.done, SHUTDOWN_DEADLINE_MS)).resolves.toBe('settled');
            expect(res.statusCode).toBe(500);
            await server.ssrLoadModule(countCallsFunc.absolutePath);
            const next = call(server, countCallsFunc, [0]);
            await next.done;
            expect(next.statusCode).toBe(200);
        } finally {
            await server.close();
        }
    }, 30000);
});
