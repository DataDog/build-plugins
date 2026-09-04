// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import { getAuthenticatedRequest } from '@dd/apps-plugin/auth';
import { createDevServerMiddleware, getRetryDelay } from '@dd/apps-plugin/vite/dev-server';
import type { AuthOptionsWithDefaults, RequestOpts } from '@dd/core/types';
import { cleanEnv } from '@dd/tests/_jest/helpers/env';
import {
    createMockRequest,
    createMockResponse,
    getMockLogger,
    mockLogFn,
    moduleResolverFor,
} from '@dd/tests/_jest/helpers/mocks';
import type { IncomingMessage } from 'http';
import nock from 'nock';
import { parseAst } from 'rollup/parseAst';

import { encodeQueryName } from '../backend/encodeQueryName';
import type { BackendFunction } from '../backend/types';
import { LOCAL_EXECUTION_LOAD_SUFFIX } from '../constants';
import type { AppsOptionsWithDefaults } from '../types';

/** Shape of the `$.Actions` dynamic proxy — a nested property path (e.g. `$.Actions.slack.chat.postMessage`) callable at any depth; types `globalThis.$` in tests without an `any` cast. */
type ActionsProxy = { [key: string]: ActionsProxy } & ((...args: unknown[]) => Promise<unknown>);

/** Reads the `$.Actions` local-execution.ts installs onto `globalThis` — genuinely untyped, so the cast is centralized here instead of repeated at each call site. */
function testDollarActions(): ActionsProxy {
    return (globalThis as typeof globalThis & { $: { Actions: ActionsProxy } }).$.Actions;
}

const mockViteBuild = jest.fn();

/** Stands in for the real `server.ssrLoadModule` — the local executeAction path doesn't bundle, so tests exercising it configure this directly instead of `mockBuildWithParsedBackend`. */
const mockLoadModule = jest.fn();

const DD_API_ORIGIN = 'https://api.datadoghq.com';

const mockFunctions: BackendFunction[] = [
    {
        relativePath: 'backend/greet',
        name: 'greet',
        absolutePath: '/project/backend/greet.backend.ts',
        allowedConnectionIds: [],
    },
    {
        relativePath: 'backend/compute',
        name: 'compute',
        absolutePath: '/project/backend/compute.backend.ts',
        allowedConnectionIds: [],
    },
];

const mockAuth: AuthOptionsWithDefaults = {
    site: 'datadoghq.com',
};

const mockLog = getMockLogger();
// getAuthenticatedRequest reads the OAuth token from the environment. Jest's
// setupAfterEnv cleanEnv strips env vars after collection, so the authenticated
// request is captured once at collection time — describe bodies and test
// bodies both reuse it. The bearer test pins the token itself to exercise a
// live construction. Developer-provided API keys are stripped so the bearer
// path is deterministic.
const TEST_OAUTH_TOKEN = 'test-oauth-token';
const restoreModuleEnv = cleanEnv();
process.env.DD_OAUTH_ACCESS_TOKEN = TEST_OAUTH_TOKEN;
const testAuthenticatedRequest = getAuthenticatedRequest();

afterAll(() => {
    restoreModuleEnv();
});

// Disable jitter/backoff so retry tests don't add unnecessary delay.
const mockLongPolling: AppsOptionsWithDefaults['longPolling'] = {
    maxRetries: 10,
    timeoutMs: 40000,
    jitter: false,
    exponentialBackoff: false,
};

/**
 * Helper to create a fake Vite build result.
 */
function mockBuildResult(code: string) {
    return {
        output: [{ type: 'chunk', code }],
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
    importedIds: string[] = [],
) {
    for (const plugin of config.plugins ?? []) {
        plugin.moduleParsed?.call(
            { parse: parseAst },
            {
                id,
                code,
                importedIds,
            },
        );
    }
}

function mockBuildWithParsedBackend(code = '// code') {
    mockViteBuild.mockImplementation(async (config) => {
        for (const func of mockFunctions) {
            emitModuleParsed(
                config,
                func.absolutePath,
                `export function ${func.name}() { return null; }`,
            );
        }
        return mockBuildResult(code);
    });
}

describe('getRetryDelay', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    // Base delay is 250ms, capped at 2000ms, with equal jitter (half fixed, half random).
    const cases: {
        description: string;
        attempt: number;
        config: AppsOptionsWithDefaults['longPolling'];
        random: number;
        expected: number;
    }[] = [
        {
            description: 'return the fixed base delay when jitter and backoff are disabled',
            attempt: 1,
            config: { maxRetries: 10, timeoutMs: 40000, jitter: false, exponentialBackoff: false },
            random: 0.5,
            expected: 250,
        },
        {
            description:
                'return the same fixed delay regardless of attempt when backoff is disabled',
            attempt: 5,
            config: { maxRetries: 10, timeoutMs: 40000, jitter: false, exponentialBackoff: false },
            random: 0.5,
            expected: 250,
        },
        {
            description: 'double the delay on each attempt when exponential backoff is enabled',
            attempt: 2,
            config: { maxRetries: 10, timeoutMs: 40000, jitter: false, exponentialBackoff: true },
            random: 0.5,
            expected: 500,
        },
        {
            description:
                'keep doubling the delay across attempts when exponential backoff is enabled',
            attempt: 4,
            config: { maxRetries: 10, timeoutMs: 40000, jitter: false, exponentialBackoff: true },
            random: 0.5,
            expected: 2000,
        },
        {
            description: 'cap the exponential delay at the max delay',
            attempt: 10,
            config: { maxRetries: 10, timeoutMs: 40000, jitter: false, exponentialBackoff: true },
            random: 0.5,
            expected: 2000,
        },
        {
            description:
                'apply the minimum jitter delay (half the base) when Math.random returns 0',
            attempt: 1,
            config: { maxRetries: 10, timeoutMs: 40000, jitter: true, exponentialBackoff: false },
            random: 0,
            expected: 125,
        },
        {
            description:
                'apply the maximum jitter delay (the full base) when Math.random returns close to 1',
            attempt: 1,
            config: { maxRetries: 10, timeoutMs: 40000, jitter: true, exponentialBackoff: false },
            random: 0.999999,
            expected: 249.9998,
        },
        {
            description: 'combine jitter with the exponential backoff delay for the given attempt',
            attempt: 3,
            config: { maxRetries: 10, timeoutMs: 40000, jitter: true, exponentialBackoff: true },
            random: 0.5,
            expected: 750,
        },
    ];

    test.each(cases)('should $description', ({ attempt, config, random, expected }) => {
        jest.spyOn(Math, 'random').mockReturnValue(random);
        expect(getRetryDelay(attempt, config)).toBeCloseTo(expected);
    });
});

/**
 * Configures `mockLoadModule` to resolve `func`'s absolute path to a module
 * exporting a single named function, matching what the real `ssrLoadModule`
 * returns for a real backend-function file.
 */
function mockLoadModuleReturning(func: BackendFunction, fn: (...args: never[]) => unknown) {
    const resolveModule = moduleResolverFor(func, { [func.name]: fn });
    mockLoadModule.mockImplementation(resolveModule);
}

const previewRuntimeContext = {
    Source: {
        initiator: { id: 'preview-initiator', orgId: 'preview-org' },
        runAsUser: { id: 'preview-run-as', orgId: 'preview-org' },
    },
};

function mockRuntimeContextHydration(
    times: number = 1,
    outputs: unknown = { data: previewRuntimeContext },
) {
    return nock(DD_API_ORIGIN, {
        reqheaders: { Authorization: 'Bearer test-oauth-token' },
    })
        .post('/api/v2/app-builder/queries/preview-async', (body) => {
            const querySpec = (
                body as {
                    data?: {
                        attributes?: {
                            query?: {
                                properties?: {
                                    spec?: {
                                        fqn?: unknown;
                                        inputs?: {
                                            script?: unknown;
                                            allowedConnectionIds?: unknown;
                                            context?: unknown;
                                        };
                                    };
                                };
                            };
                        };
                    };
                }
            ).data?.attributes?.query?.properties?.spec;
            return (
                querySpec?.fqn === 'com.datadoghq.datatransformation.jsFunctionWithActions' &&
                typeof querySpec.inputs?.script === 'string' &&
                querySpec.inputs.script.includes('return $;') &&
                JSON.stringify(querySpec.inputs.allowedConnectionIds) === '[]' &&
                JSON.stringify(querySpec.inputs.context) === '{}'
            );
        })
        .times(times)
        .reply(200, { data: { id: 'runtime-context-receipt' } })
        .get('/api/v2/app-builder/queries/execution-long-polling/runtime-context-receipt')
        .times(times)
        .reply(200, {
            data: { attributes: { done: true, outputs } },
        });
}

function makeImmediateRuntimeContextRequest() {
    return jest
        .fn()
        .mockResolvedValueOnce({ data: { id: 'runtime-context-receipt' } })
        .mockResolvedValueOnce({
            data: {
                attributes: {
                    done: true,
                    outputs: { data: previewRuntimeContext },
                },
            },
        });
}

describe('Dev Server Middleware', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockViteBuild.mockReset();
        mockLoadModule.mockReset();
    });

    afterEach(() => {
        nock.cleanAll();
    });

    describe('createDevServerMiddleware routing', () => {
        const middleware = createDevServerMiddleware(
            mockViteBuild,
            mockLoadModule,
            () => mockFunctions,
            async () => [],
            mockAuth,
            testAuthenticatedRequest,
            mockLongPolling,
            '/project',
            mockLog,
        );

        test('Should call next() for non-POST requests', () => {
            const req = { method: 'GET', url: '/__dd/debugBundle' } as unknown as IncomingMessage;
            const res = createMockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('Should call next() for unrelated URLs', () => {
            const req = {
                method: 'POST',
                url: '/some-other-path',
            } as unknown as IncomingMessage;
            const res = createMockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('Should handle /__dd/debugBundle POST', async () => {
            mockBuildWithParsedBackend();

            const req = createMockRequest('/__dd/debugBundle', {
                functionName: encodeQueryName(mockFunctions[0]),
            });
            const res = createMockResponse();
            const next = jest.fn();

            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();

            await res.done;

            expect(res.statusCode).toBe(200);
            expect(res.end).toHaveBeenCalled();
        });

        test('Should handle /__dd/executeAction POST by hydrating context and running the function locally without bundling', async () => {
            mockRuntimeContextHydration();
            mockLoadModuleReturning(mockFunctions[0], (arg) => arg);

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: ['world'],
            });
            const res = createMockResponse();
            const next = jest.fn();

            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();

            await res.done;

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(true);
            expect(body.result).toEqual({ data: 'world' });
        });

        test('Should handle /__dd/executeActionViaCloud POST', async () => {
            mockBuildWithParsedBackend();

            // Mock the Datadog API via nock.
            const apiScope = nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(200, { data: { id: 'receipt-123' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-123')
                .reply(200, {
                    data: {
                        attributes: {
                            done: true,
                            outputs: { data: { result: 'hello' } },
                        },
                    },
                });

            const req = createMockRequest('/__dd/executeActionViaCloud', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: ['world'],
            });
            const res = createMockResponse();
            const next = jest.fn();

            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();

            await res.done;

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(true);
            expect(body.result).toEqual({ data: { result: 'hello' } });
            expect(apiScope.isDone()).toBe(true);
        });
    });

    describe('debugBundle handler', () => {
        const middleware = createDevServerMiddleware(
            mockViteBuild,
            mockLoadModule,
            () => mockFunctions,
            async () => [],
            mockAuth,
            testAuthenticatedRequest,
            mockLongPolling,
            '/project',
            mockLog,
        );

        test('Should return 400 for missing functionRef', async () => {
            const req = createMockRequest('/__dd/debugBundle', {});
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(400);
            expect(JSON.parse(res.getBody()).error).toContain('Missing or invalid functionName');
        });

        test('Should return 404 for unknown function', async () => {
            const req = createMockRequest('/__dd/debugBundle', {
                functionName: 'nonexistent.nonexistent',
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(404);
            expect(JSON.parse(res.getBody()).error).toContain('not found');
        });

        test('Should return bundled code as text/plain', async () => {
            mockBuildWithParsedBackend('export function main($) {}');

            const req = createMockRequest('/__dd/debugBundle', {
                functionName: encodeQueryName(mockFunctions[0]),
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain');
            expect(res.getBody()).toContain('export function main($)');
        });

        test('Should reject a bundle whose imported helper module has a restricted import or global', async () => {
            // Emits moduleParsed for both the entry and a helper module, to prove the static-checks plugin covers the helper too, not just the entry file.
            mockViteBuild.mockImplementation(async (config) => {
                emitModuleParsed(
                    config,
                    mockFunctions[0].absolutePath,
                    `export function ${mockFunctions[0].name}() { return null; }`,
                );
                emitModuleParsed(
                    config,
                    '/project/backend/helpers/secrets.ts',
                    "import fs from 'fs';\nexport function readSecret() { return fs.readFileSync('/etc/passwd'); }",
                );
                return mockBuildResult('// code');
            });

            const encodedFunctionName = encodeQueryName(mockFunctions[0]);
            const req = createMockRequest('/__dd/debugBundle', {
                functionName: encodedFunctionName,
            });
            const res = createMockResponse();
            const next = jest.fn();

            middleware(req, res, next);
            await res.done;

            expect(res.statusCode).toBe(500);
            const responseText = res.getBody();
            const body = JSON.parse(responseText);
            expect(body.error).toContain(
                'Importing Node built-in module "fs" is not supported in backend function code',
            );
        });

        test('Should call vite.build with configFile: false and write: false', async () => {
            mockBuildWithParsedBackend();

            const req = createMockRequest('/__dd/debugBundle', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [1, 2],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(mockViteBuild).toHaveBeenCalledWith(
                expect.objectContaining({
                    configFile: false,
                    root: '/project',
                    logLevel: 'silent',
                    build: expect.objectContaining({
                        write: false,
                        minify: false,
                    }),
                }),
            );
        });
    });

    describe('executeActionViaCloud handler', () => {
        const middleware = createDevServerMiddleware(
            mockViteBuild,
            mockLoadModule,
            () => mockFunctions,
            async () => [],
            mockAuth,
            testAuthenticatedRequest,
            mockLongPolling,
            '/project',
            mockLog,
        );

        test('Should return 400 for missing functionRef', async () => {
            const req = createMockRequest('/__dd/executeActionViaCloud', {});
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(400);
        });

        test('Should return 404 for unknown function', async () => {
            const req = createMockRequest('/__dd/executeActionViaCloud', {
                functionName: 'nonexistent.nonexistent',
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(404);
        });

        test('Should reject a request with no auth configured upfront, matching the /__dd/executeAction gate', async () => {
            const noAuthMiddleware = createDevServerMiddleware(
                mockViteBuild,
                mockLoadModule,
                () => mockFunctions,
                async () => [],
                mockAuth,
                undefined,
                mockLongPolling,
                '/project',
                mockLog,
            );

            const req = createMockRequest('/__dd/executeActionViaCloud', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            noAuthMiddleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(400);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(false);
            expect(body.error).toContain('Auth credentials not configured');
        });

        /*
         * The nock mock replies with 403 to simulate the upstream Datadog API
         * rejecting the request (e.g. bad credentials). The middleware still
         * returns 500 because from the caller's perspective this is a
         * server-side failure — the caller's request was valid, the dev server
         * just couldn't fulfill it. This is distinct from the 400/404 cases
         * above, which represent client mistakes (missing functionRef,
         * unknown function).
         */
        test('Should return 500 when Datadog API fails', async () => {
            mockBuildWithParsedBackend();

            nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(403, 'Forbidden');

            const req = createMockRequest('/__dd/executeActionViaCloud', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(500);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(false);
            expect(body.error).toContain('HTTP 403');
        });

        test('Should call Datadog API with correct endpoint and return result', async () => {
            mockBuildWithParsedBackend();

            type PreviewAsyncBody = {
                data: {
                    attributes: {
                        query: {
                            properties: {
                                spec: {
                                    inputs: {
                                        allowedConnectionIds: string[];
                                        context: { backendFunctionArgs: unknown[] };
                                    };
                                };
                            };
                        };
                        template_params: Record<string, unknown>;
                    };
                };
            };
            let capturedBody: PreviewAsyncBody | undefined;
            const apiScope = nock(DD_API_ORIGIN, {
                reqheaders: {
                    Authorization: 'Bearer test-oauth-token',
                },
            })
                .post('/api/v2/app-builder/queries/preview-async', (body) => {
                    capturedBody = body as PreviewAsyncBody;
                    return true;
                })
                .reply(200, { data: { id: 'receipt-1' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-1')
                .reply(200, {
                    data: { attributes: { done: true, outputs: { data: { value: 42 } } } },
                });

            const req = createMockRequest('/__dd/executeActionViaCloud', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: ['hello', 42],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(true);
            expect(body.result).toEqual({ data: { value: 42 } });
            expect(apiScope.isDone()).toBe(true);
            const inputs = capturedBody?.data.attributes.query.properties.spec.inputs;
            expect(inputs?.allowedConnectionIds).toEqual([]);
            // Args flow through inputs.context, not template_params. This keeps
            // them as structured JSON values instead of being textually
            // substituted into the script source.
            expect(inputs?.context).toEqual({ backendFunctionArgs: ['hello', 42] });
            expect(capturedBody?.data.attributes.template_params).toEqual({});
        });

        test('Should call Datadog API with bearer auth and no API/App key headers', async () => {
            mockBuildWithParsedBackend();
            // setupAfterEnv's cleanEnv strips env vars after collection, so the
            // token must be set in the test body for this live construction.
            process.env.DD_OAUTH_ACCESS_TOKEN = TEST_OAUTH_TOKEN;

            const bearerMiddleware = createDevServerMiddleware(
                mockViteBuild,
                mockLoadModule,
                () => mockFunctions,
                async () => [],
                mockAuth,
                getAuthenticatedRequest(),
                mockLongPolling,
                '/project',
                mockLog,
            );

            const apiScope = nock(DD_API_ORIGIN, {
                reqheaders: {
                    Authorization: 'Bearer test-oauth-token',
                },
                badheaders: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
            })
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(200, { data: { id: 'receipt-oauth' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-oauth')
                .reply(200, {
                    data: { attributes: { done: true, outputs: { data: { ok: true } } } },
                });

            const req = createMockRequest('/__dd/executeActionViaCloud', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            bearerMiddleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(true);
            expect(body.result).toEqual({ data: { ok: true } });
            expect(apiScope.isDone()).toBe(true);
        });

        test('Should return 400 with auth guidance when the access token is missing', async () => {
            const noKeyMiddleware = createDevServerMiddleware(
                mockViteBuild,
                mockLoadModule,
                () => mockFunctions,
                async () => [],
                mockAuth,
                undefined,
                mockLongPolling,
                '/project',
                mockLog,
            );

            const req = createMockRequest('/__dd/executeActionViaCloud', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            noKeyMiddleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(400);
            const body = JSON.parse(res.getBody());
            expect(body.error).toContain('DD_OAUTH_ACCESS_TOKEN');
            expect(body.error).toContain('datadog-apps dev');
            expect(mockViteBuild).not.toHaveBeenCalled();
        });

        test('Should round-trip args containing single quotes via inputs.context', async () => {
            // Regression: textual substitution into a single-quoted JS string
            // literal broke when args contained `'`. Args must now appear
            // verbatim in inputs.context with no escaping or stringification.
            mockBuildWithParsedBackend();

            type PreviewAsyncBody = {
                data: {
                    attributes: {
                        query: {
                            properties: {
                                spec: {
                                    inputs: {
                                        context: { backendFunctionArgs: unknown[] };
                                    };
                                };
                            };
                        };
                    };
                };
            };
            let capturedBody: PreviewAsyncBody | undefined;
            const apiScope = nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async', (body) => {
                    capturedBody = body as PreviewAsyncBody;
                    return true;
                })
                .reply(200, { data: { id: 'receipt-quote' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-quote')
                .reply(200, {
                    data: { attributes: { done: true, outputs: { data: { ok: true } } } },
                });

            const trickyArgs = ["don't break", "'); alert(1); //", '😀'];
            const req = createMockRequest('/__dd/executeActionViaCloud', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: trickyArgs,
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            expect(apiScope.isDone()).toBe(true);
            expect(
                capturedBody?.data.attributes.query.properties.spec.inputs.context
                    .backendFunctionArgs,
            ).toEqual(trickyArgs);
        });

        test('Should use collector output instead of registered backend function allowedConnectionIds', async () => {
            mockBuildWithParsedBackend();

            const functionsWithAllowlist: BackendFunction[] = [
                mockFunctions[0],
                {
                    ...mockFunctions[1],
                    allowedConnectionIds: ['conn-1', 'conn-2'],
                },
            ];
            const middlewareWithAllowlist = createDevServerMiddleware(
                mockViteBuild,
                mockLoadModule,
                () => functionsWithAllowlist,
                async () => [],
                mockAuth,
                testAuthenticatedRequest,
                mockLongPolling,
                '/project',
                mockLog,
            );

            type PreviewAsyncBody = {
                data: {
                    attributes: {
                        query: {
                            properties: {
                                spec: { inputs: { allowedConnectionIds: string[] } };
                            };
                        };
                    };
                };
            };
            let capturedBody: PreviewAsyncBody | undefined;
            const apiScope = nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async', (body) => {
                    capturedBody = body as PreviewAsyncBody;
                    return true;
                })
                .reply(200, { data: { id: 'receipt-allowlist' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-allowlist')
                .reply(200, {
                    data: { attributes: { done: true, outputs: { data: { ok: true } } } },
                });

            const req = createMockRequest('/__dd/executeActionViaCloud', {
                functionName: encodeQueryName(functionsWithAllowlist[1]),
                args: [],
            });
            const res = createMockResponse();

            middlewareWithAllowlist(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            expect(apiScope.isDone()).toBe(true);
            expect(
                capturedBody?.data.attributes.query.properties.spec.inputs.allowedConnectionIds,
            ).toEqual([]);
        });

        test('Should compute allowedConnectionIds from the backend build collector', async () => {
            mockViteBuild.mockImplementation(async (config) => {
                emitModuleParsed(
                    config,
                    mockFunctions[0].absolutePath,
                    `
                        import { request } from '@datadog/action-catalog/http/http';

                        export function greet() {
                            request({ connectionId: 'conn-build', inputs: {} });
                        }
                    `,
                );
                return mockBuildResult('// code');
            });

            type PreviewAsyncBody = {
                data: {
                    attributes: {
                        query: {
                            properties: {
                                spec: { inputs: { allowedConnectionIds: string[] } };
                            };
                        };
                    };
                };
            };
            let capturedBody: PreviewAsyncBody | undefined;
            const apiScope = nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async', (body) => {
                    capturedBody = body as PreviewAsyncBody;
                    return true;
                })
                .reply(200, { data: { id: 'receipt-build-allowlist' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-build-allowlist')
                .reply(200, {
                    data: { attributes: { done: true, outputs: { data: { ok: true } } } },
                });

            const req = createMockRequest('/__dd/executeActionViaCloud', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            expect(apiScope.isDone()).toBe(true);
            expect(
                capturedBody?.data.attributes.query.properties.spec.inputs.allowedConnectionIds,
            ).toEqual(['conn-build']);
        });

        test('Should handle errors array from long-polling endpoint', async () => {
            mockBuildWithParsedBackend();

            nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(200, { data: { id: 'receipt-err' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-err')
                .reply(200, {
                    errors: [{ title: 'ExecutionFailed', detail: 'Script threw an error' }],
                });

            const req = createMockRequest('/__dd/executeActionViaCloud', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(500);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(false);
            expect(body.error).toContain('Script threw an error');
        });

        test('Should retry when long-poll returns done: false', async () => {
            mockBuildWithParsedBackend();

            const apiScope = nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(200, { data: { id: 'receipt-retry' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-retry')
                .reply(200, { data: { attributes: { done: false } } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-retry')
                .reply(200, {
                    data: { attributes: { done: true, outputs: { data: { ok: true } } } },
                });

            const req = createMockRequest('/__dd/executeActionViaCloud', {
                functionName: encodeQueryName(mockFunctions[0]),
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
        });

        test('Should not retry when maxRetries is 1 (long-polling disabled)', async () => {
            mockBuildWithParsedBackend();

            const singleAttemptMiddleware = createDevServerMiddleware(
                mockViteBuild,
                mockLoadModule,
                () => mockFunctions,
                async () => [],
                mockAuth,
                testAuthenticatedRequest,
                { ...mockLongPolling, maxRetries: 1 },
                '/project',
                mockLog,
            );

            const apiScope = nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(200, { data: { id: 'receipt-no-retry' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-no-retry')
                .reply(200, { data: { attributes: { done: false } } });

            const req = createMockRequest('/__dd/executeActionViaCloud', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            singleAttemptMiddleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(500);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(false);
            expect(body.error).toContain('Query execution timed out');
            expect(apiScope.isDone()).toBe(true);
        });

        test('Should retry the next attempt when a long-poll attempt stalls past timeoutMs', async () => {
            mockBuildWithParsedBackend();

            // A stalled connection must be abandoned and re-polled, not surfaced
            // as a failed action: the receipt stays valid across attempts.
            const stallingMiddleware = createDevServerMiddleware(
                mockViteBuild,
                mockLoadModule,
                () => mockFunctions,
                async () => [],
                mockAuth,
                testAuthenticatedRequest,
                { ...mockLongPolling, timeoutMs: 100 },
                '/project',
                mockLog,
            );

            const apiScope = nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(200, { data: { id: 'receipt-stall' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-stall')
                .delayConnection(1_000)
                .reply(200, { data: { attributes: { done: true, outputs: { data: 'late' } } } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-stall')
                .reply(200, {
                    data: { attributes: { done: true, outputs: { data: { ok: true } } } },
                });

            const req = createMockRequest('/__dd/executeActionViaCloud', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            stallingMiddleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(true);
            expect(body.result).toEqual({ data: { ok: true } });
            expect(apiScope.isDone()).toBe(true);
        });

        test('Should surface non-abort request errors instead of retrying them away', async () => {
            mockBuildWithParsedBackend();

            const apiScope = nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(200, { data: { id: 'receipt-bad-request' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-bad-request')
                .reply(403, { errors: [{ detail: 'Forbidden receipt' }] });

            const req = createMockRequest('/__dd/executeActionViaCloud', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(500);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(false);
            expect(body.error).toContain('Forbidden receipt');
            expect(body.error).not.toContain('Query execution timed out');
            expect(apiScope.isDone()).toBe(true);
        });
    });

    describe('executeAction handler (local)', () => {
        beforeEach(() => {
            mockRuntimeContextHydration();
        });

        const middleware = createDevServerMiddleware(
            mockViteBuild,
            mockLoadModule,
            () => mockFunctions,
            async () => [],
            mockAuth,
            testAuthenticatedRequest,
            mockLongPolling,
            '/project',
            mockLog,
        );

        test('Should return 400 for missing functionRef', async () => {
            const req = createMockRequest('/__dd/executeAction', {});
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(400);
        });

        test('Should return 404 for unknown function', async () => {
            const req = createMockRequest('/__dd/executeAction', {
                functionName: 'nonexistent.nonexistent',
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(404);
        });

        test('Should hydrate context, run the function directly in-process, and return its result without bundling', async () => {
            mockLoadModuleReturning(mockFunctions[0], (arg: number) => arg * 2);

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [21],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(true);
            expect(body.result).toEqual({ data: 42 });
            expect(mockViteBuild).not.toHaveBeenCalled();
        });

        test('Should reject a malformed hydrated identity before loading customer code without exposing the response body', async () => {
            nock.cleanAll();
            mockRuntimeContextHydration(1, {
                data: {
                    Source: {
                        initiator: { id: 'initiator-without-org' },
                        runAsUser: { id: 'run-as', orgId: 'preview-org' },
                    },
                    secretSentinel: 'must-not-appear',
                },
            });

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(500);
            const body = JSON.parse(res.getBody());
            expect(body.error).toContain('Source.initiator');
            expect(body.error).not.toContain('must-not-appear');
            expect(mockLoadModule).not.toHaveBeenCalled();
            expect(mockLogFn).not.toHaveBeenCalledWith(
                expect.stringContaining('must-not-appear'),
                expect.anything(),
            );
        });

        test('Should reject hydration outputs with no data field before loading customer code', async () => {
            nock.cleanAll();
            mockRuntimeContextHydration(1, {});

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(500);
            const body = JSON.parse(res.getBody());
            expect(body.error).toContain(
                'Runtime context hydration completed without a "data" field',
            );
            expect(mockLoadModule).not.toHaveBeenCalled();
        });

        test('Should abort stalled runtime-context hydration so later local executions are not wedged', async () => {
            jest.useFakeTimers();
            try {
                nock.cleanAll();
                const hangingRuntimeContextRequest = <T>(options: Omit<RequestOpts, 'auth'>) =>
                    new Promise<T>((_resolve, reject) => {
                        options.signal?.addEventListener(
                            'abort',
                            () => reject(options.signal?.reason),
                            { once: true },
                        );
                    });
                const hangingHydrationMiddleware = createDevServerMiddleware(
                    mockViteBuild,
                    mockLoadModule,
                    () => mockFunctions,
                    async () => [],
                    mockAuth,
                    hangingRuntimeContextRequest,
                    mockLongPolling,
                    '/project',
                    mockLog,
                );

                const req = createMockRequest('/__dd/executeAction', {
                    functionName: encodeQueryName(mockFunctions[0]),
                    args: [],
                });
                const res = createMockResponse();

                hangingHydrationMiddleware(req, res, jest.fn());
                const doneAssertion = res.done;
                await jest.advanceTimersByTimeAsync(0);
                await jest.advanceTimersByTimeAsync(60_000);
                await doneAssertion;

                expect(res.statusCode).toBe(500);
                const body = JSON.parse(res.getBody());
                expect(body.error).toContain('Runtime context hydration timed out after 60000ms');
                expect(mockLoadModule).not.toHaveBeenCalled();

                const recoveringRuntimeContextRequest = makeImmediateRuntimeContextRequest();
                const recoveringMiddleware = createDevServerMiddleware(
                    mockViteBuild,
                    mockLoadModule,
                    () => mockFunctions,
                    async () => [],
                    mockAuth,
                    recoveringRuntimeContextRequest,
                    mockLongPolling,
                    '/project',
                    mockLog,
                );
                mockLoadModuleReturning(mockFunctions[0], () => 'recovered');
                const recoveringReq = createMockRequest('/__dd/executeAction', {
                    functionName: encodeQueryName(mockFunctions[0]),
                    args: [],
                });
                const recoveringRes = createMockResponse();

                recoveringMiddleware(recoveringReq, recoveringRes, jest.fn());
                const recoveringDone = recoveringRes.done;
                await jest.advanceTimersByTimeAsync(0);
                await recoveringDone;

                expect(recoveringRes.statusCode).toBe(200);
                expect(JSON.parse(recoveringRes.getBody()).result).toEqual({
                    data: 'recovered',
                });
            } finally {
                jest.useRealTimers();
            }
        });

        test('Should reject a request with no auth configured upfront, even for a function that never calls $.Actions — matching production, which authenticates before any backend code runs', async () => {
            const noAuthMiddleware = createDevServerMiddleware(
                mockViteBuild,
                mockLoadModule,
                () => mockFunctions,
                async () => [],
                mockAuth,
                undefined,
                mockLongPolling,
                '/project',
                mockLog,
            );
            mockLoadModuleReturning(mockFunctions[0], () => 'pure result, no $.Actions call');

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            noAuthMiddleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(400);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(false);
            expect(body.error).toContain('Auth credentials not configured');
        });

        test('Should route a real $.Actions call (including connectionId) through a direct single-action preview-async query, not the jsFunctionWithActions wrapper', async () => {
            const funcWithConnection: BackendFunction = {
                ...mockFunctions[0],
                allowedConnectionIds: ['conn-1'],
            };
            const middlewareWithConnection = createDevServerMiddleware(
                mockViteBuild,
                mockLoadModule,
                () => [funcWithConnection, mockFunctions[1]],
                async (entryId: string) =>
                    entryId === funcWithConnection.absolutePath ? ['conn-1'] : [],
                mockAuth,
                testAuthenticatedRequest,
                mockLongPolling,
                '/project',
                mockLog,
            );
            mockLoadModuleReturning(funcWithConnection, () =>
                testDollarActions().slack.chat.postMessage({
                    inputs: { text: 'hi' },
                    connectionId: 'conn-1',
                }),
            );

            type PreviewAsyncBody = {
                data: {
                    attributes: {
                        query: {
                            properties: {
                                spec: {
                                    fqn: string;
                                    inputs: Record<string, unknown>;
                                    connectionId?: string;
                                };
                            };
                        };
                    };
                };
            };
            let capturedBody: PreviewAsyncBody | undefined;
            const apiScope = nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async', (body) => {
                    capturedBody = body as PreviewAsyncBody;
                    return true;
                })
                .reply(200, { data: { id: 'receipt-action' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-action')
                .reply(200, {
                    data: { attributes: { done: true, outputs: { ok: true, ts: '123' } } },
                });

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(funcWithConnection),
                args: [],
            });
            const res = createMockResponse();

            middlewareWithConnection(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(true);
            // The action's raw output ({ok, ts}) is what $.Actions.foo.bar() resolves to; the
            // outer {data: ...} comes from executeScriptLocally's usual return-value wrapping,
            // not anything action-specific.
            expect(body.result).toEqual({ data: { ok: true, ts: '123' } });
            expect(apiScope.isDone()).toBe(true);
            expect(capturedBody?.data.attributes.query.properties.spec).toEqual({
                fqn: 'com.datadoghq.slack.chat.postMessage',
                inputs: { text: 'hi' },
                connectionId: 'conn-1',
            });
        });

        // makeExecuteActionRemotely must check connectionId with the same `!== undefined`
        // strictness assertConnectionIdAllowed uses, not a truthy check that would drop an
        // allowed empty string and send an unscoped call instead.
        test('Should forward an empty-string connectionId to the preview-async query spec rather than silently dropping it', async () => {
            const funcWithEmptyConnection: BackendFunction = {
                ...mockFunctions[0],
                allowedConnectionIds: [''],
            };
            const middlewareWithEmptyConnection = createDevServerMiddleware(
                mockViteBuild,
                mockLoadModule,
                () => [funcWithEmptyConnection, mockFunctions[1]],
                async (entryId: string) =>
                    entryId === funcWithEmptyConnection.absolutePath ? [''] : [],
                mockAuth,
                testAuthenticatedRequest,
                mockLongPolling,
                '/project',
                mockLog,
            );
            mockLoadModuleReturning(funcWithEmptyConnection, () =>
                testDollarActions().slack.chat.postMessage({
                    inputs: { text: 'hi' },
                    connectionId: '',
                }),
            );

            let capturedBody:
                | {
                      data: {
                          attributes: {
                              query: { properties: { spec: { connectionId?: string } } };
                          };
                      };
                  }
                | undefined;
            const apiScope = nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async', (body) => {
                    capturedBody = body as typeof capturedBody;
                    return true;
                })
                .reply(200, { data: { id: 'receipt-empty-connection' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-empty-connection')
                .reply(200, {
                    data: { attributes: { done: true, outputs: { ok: true } } },
                });

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(funcWithEmptyConnection),
                args: [],
            });
            const res = createMockResponse();

            middlewareWithEmptyConnection(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            expect(apiScope.isDone()).toBe(true);
            expect(capturedBody?.data.attributes.query.properties.spec.connectionId).toBe('');
        });

        test("Should surface a successful $.Actions call's result to the local console", async () => {
            mockLoadModuleReturning(mockFunctions[0], () =>
                testDollarActions().slack.chat.postMessage({
                    inputs: { text: 'hi' },
                }),
            );

            nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(200, { data: { id: 'receipt-success' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-success')
                .reply(200, {
                    data: { attributes: { done: true, outputs: { ok: true } } },
                });

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('com.datadoghq.slack.chat.postMessage'),
                'info',
            );
            expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('"ok":true'), 'info');
        });

        test("Should surface a failed $.Actions call's error detail to the local console", async () => {
            mockLoadModuleReturning(mockFunctions[0], () =>
                testDollarActions().slack.chat.postMessage({
                    inputs: { text: 'hi' },
                }),
            );

            nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(200, { data: { id: 'receipt-failure' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-failure')
                .reply(200, {
                    errors: [{ detail: 'Connection is not authorized for this action' }],
                });

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(500);
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('com.datadoghq.slack.chat.postMessage'),
                'error',
            );
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('Connection is not authorized for this action'),
                'error',
            );
        });

        // The priming loadModule call (see handleExecuteAction) is the only place the entry's
        // top-level code runs (Vite caches the module for executeScriptLocally's reuse), so it
        // must carry the same $-scoping guarantee executeScriptLocally's own load would provide.
        test('Should read $ as undefined when a customer module reaches for it during its own top-level evaluation, before runScriptLocally installs its own execution-scoped $', async () => {
            let dollarDuringTopLevelLoad: unknown = 'not captured';
            mockLoadModule.mockImplementation(async (specifier: string) => {
                if (specifier === mockFunctions[0].absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    dollarDuringTopLevelLoad = (globalThis as Record<string, unknown>).$;
                    return { [mockFunctions[0].name]: () => 'done' };
                }
                throw new Error(`Cannot find module '${specifier}'`);
            });

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            expect(dollarDuringTopLevelLoad).toBeUndefined();
        });

        // The priming load runs before runScriptLocally's own hang-detection timeout is
        // installed, so a hanging top-level await would otherwise wedge this request and every
        // request queued behind it forever.
        test('Should eventually time out and return a clear error when the priming load never settles', async () => {
            jest.useFakeTimers();
            try {
                const immediateRuntimeContextRequest = makeImmediateRuntimeContextRequest();
                const immediateHydrationMiddleware = createDevServerMiddleware(
                    mockViteBuild,
                    mockLoadModule,
                    () => mockFunctions,
                    async () => [],
                    mockAuth,
                    immediateRuntimeContextRequest,
                    mockLongPolling,
                    '/project',
                    mockLog,
                );
                mockLoadModule.mockImplementation(
                    // Never settles.
                    () => new Promise(() => {}),
                );

                const req = createMockRequest('/__dd/executeAction', {
                    functionName: encodeQueryName(mockFunctions[0]),
                    args: [],
                });
                const res = createMockResponse();

                immediateHydrationMiddleware(req, res, jest.fn());
                const doneAssertion = res.done;

                // createMockRequest emits the body via a real process.nextTick, which fake timers
                // don't advance — drain it first so the priming load's setTimeout is scheduled
                // before runAllTimersAsync tries to advance past it.
                await jest.advanceTimersByTimeAsync(0);
                await jest.runAllTimersAsync();
                await doneAssertion;

                expect(res.statusCode).toBe(500);
                const body = JSON.parse(res.getBody());
                expect(body.error).toMatch(/timed out after 10000ms/);
            } finally {
                jest.useRealTimers();
            }
        });

        // Priming evaluates real top-level customer code — if it ran outside executeColdActionLocally's
        // enqueue() call, two concurrent requests for two different cold functions could evaluate
        // their top-level code in genuine parallel instead of one fully finishing before the other starts.
        test('Should never let two concurrent requests for different cold functions race their priming loads', async () => {
            mockRuntimeContextHydration();
            const order: string[] = [];
            let releaseGreetPriming: (() => void) | undefined;
            const greetPrimingGate = new Promise<void>((resolve) => {
                releaseGreetPriming = resolve;
            });

            mockLoadModule.mockImplementation(async (specifier: string) => {
                if (specifier === mockFunctions[0].absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    order.push('greet-priming-start');
                    await greetPrimingGate;
                    order.push('greet-priming-end');
                    return { [mockFunctions[0].name]: () => 'greet-done' };
                }
                if (specifier === mockFunctions[1].absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    order.push('compute-priming-start');
                    order.push('compute-priming-end');
                    return { [mockFunctions[1].name]: () => 'compute-done' };
                }
                throw new Error(`Cannot find module '${specifier}'`);
            });

            const reqGreet = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const resGreet = createMockResponse();
            const reqCompute = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[1]),
                args: [],
            });
            const resCompute = createMockResponse();

            // Fired back-to-back, before either request's own body has even finished parsing.
            middleware(reqGreet, resGreet, jest.fn());
            middleware(reqCompute, resCompute, jest.fn());

            // Give compute's request every chance to race ahead while greet's priming is gated —
            // if it weren't serialized behind greet's still-pending turn, compute's ungated
            // priming would already show up here, before greet's gate is ever released.
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(order).toEqual(['greet-priming-start']);

            releaseGreetPriming?.();
            await resGreet.done;
            await resCompute.done;

            expect(order).toEqual([
                'greet-priming-start',
                'greet-priming-end',
                'compute-priming-start',
                'compute-priming-end',
            ]);
        });

        // Regression test: getAllowedConnectionIds (which only resolves/transforms modules, never
        // executes them) must run and reject before the priming load ever evaluates the entry's
        // real top-level code — otherwise a banned import there could run before being rejected.
        test('Should never prime (evaluate) the entry when getAllowedConnectionIds rejects', async () => {
            const primingCalls: string[] = [];
            mockLoadModule.mockImplementation(async (specifier: string) => {
                primingCalls.push(specifier);
                return { [mockFunctions[0].name]: () => 'done' };
            });
            const rejectingMiddleware = createDevServerMiddleware(
                mockViteBuild,
                mockLoadModule,
                () => mockFunctions,
                async () => {
                    throw new Error('Importing Node built-in module "fs" is not supported');
                },
                mockAuth,
                testAuthenticatedRequest,
                mockLongPolling,
                '/project',
                mockLog,
            );

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            rejectingMiddleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(500);
            expect(primingCalls).toEqual([]);
        });

        // Guards getAllowedConnectionIds — it reads and transforms every reachable module from
        // disk (dev-server-module-graph.ts) with no bound of its own, unlike the sibling priming
        // load next to it in executeColdActionLocally.
        test('Should eventually time out and return a clear error when getAllowedConnectionIds never settles', async () => {
            jest.useFakeTimers();
            try {
                mockLoadModuleReturning(mockFunctions[0], () => 'done');
                const immediateRuntimeContextRequest = makeImmediateRuntimeContextRequest();
                const hangingMiddleware = createDevServerMiddleware(
                    mockViteBuild,
                    mockLoadModule,
                    () => mockFunctions,
                    // Never settles.
                    () => new Promise(() => {}),
                    mockAuth,
                    immediateRuntimeContextRequest,
                    mockLongPolling,
                    '/project',
                    mockLog,
                );

                const req = createMockRequest('/__dd/executeAction', {
                    functionName: encodeQueryName(mockFunctions[0]),
                    args: [],
                });
                const res = createMockResponse();

                hangingMiddleware(req, res, jest.fn());
                const doneAssertion = res.done;

                await jest.advanceTimersByTimeAsync(0);
                await jest.runAllTimersAsync();
                await doneAssertion;

                expect(res.statusCode).toBe(500);
                const body = JSON.parse(res.getBody());
                expect(body.error).toMatch(/timed out after 10000ms/);
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe('dynamic discovery', () => {
        test('Should not find stale function after re-transform (HMR)', async () => {
            let currentFunctions: BackendFunction[] = [...mockFunctions];
            const middleware = createDevServerMiddleware(
                mockViteBuild,
                mockLoadModule,
                () => currentFunctions,
                async () => [],
                mockAuth,
                testAuthenticatedRequest,
                mockLongPolling,
                '/project',
                mockLog,
            );

            // Simulate HMR: greet is renamed to greetV2 in the same file.
            currentFunctions = [
                {
                    relativePath: 'backend/greet',
                    name: 'greetV2',
                    absolutePath: '/project/backend/greet.backend.ts',
                    allowedConnectionIds: [],
                },
                mockFunctions[1],
            ];

            // Old name should 404.
            const oldReq = createMockRequest('/__dd/debugBundle', {
                functionName: encodeQueryName({ relativePath: 'backend/greet', name: 'greet' }),
            });
            const oldRes = createMockResponse();

            middleware(oldReq, oldRes, jest.fn());
            await oldRes.done;

            expect(oldRes.statusCode).toBe(404);

            // New name should resolve.
            mockBuildWithParsedBackend('// greetV2 code');

            const newReq = createMockRequest('/__dd/debugBundle', {
                functionName: encodeQueryName({ relativePath: 'backend/greet', name: 'greetV2' }),
            });
            const newRes = createMockResponse();

            middleware(newReq, newRes, jest.fn());
            await newRes.done;

            expect(newRes.statusCode).toBe(200);
            expect(newRes.getBody()).toContain('// greetV2 code');
        });
    });
});
