// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import { getAuthenticatedRequest } from '@dd/apps-plugin/auth';
import { createDevServerMiddleware } from '@dd/apps-plugin/vite/dev-server';
import type { AuthOptionsWithDefaults } from '@dd/core/types';
import { getMockLogger, mockLogFn, moduleResolverFor } from '@dd/tests/_jest/helpers/mocks';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import nock from 'nock';
import { parseAst } from 'rollup/parseAst';

import { encodeQueryName } from '../backend/encodeQueryName';
import type { BackendFunction } from '../backend/types';

jest.mock('@dd/core/helpers/oauth-request', () => ({
    doOAuthRequest: jest.fn(async (opts) => {
        const { doRequest } = await import('@dd/core/helpers/request');
        return doRequest({
            ...opts,
            auth: {
                accessToken: 'test-oauth-token',
            },
        });
    }),
}));

/**
 * Shape of the `$.Actions` dynamic proxy — an arbitrarily-nested property
 * path (e.g. `$.Actions.slack.chat.postMessage`) that's callable at any
 * depth. Used to type `globalThis.$` in tests without an `any` cast.
 */
type ActionsProxy = { [key: string]: ActionsProxy } & ((...args: unknown[]) => Promise<unknown>);

const mockViteBuild = jest.fn();

/**
 * Stands in for the real `server.ssrLoadModule` — the local executeAction
 * path doesn't bundle, so tests exercising it configure this directly
 * instead of `mockBuildWithParsedBackend`.
 */
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
    apiKey: 'test-api-key',
    appKey: 'test-app-key',
    site: 'datadoghq.com',
};

const mockOauthOnlyAuth: AuthOptionsWithDefaults = {
    site: 'datadoghq.com',
};

const mockLog = getMockLogger();

const getApiKeyRequest = () => getAuthenticatedRequest('apiKey', mockAuth, mockLog);
const getOAuthRequest = () => getAuthenticatedRequest('oauth', mockOauthOnlyAuth, mockLog);

/**
 * Create a mock IncomingMessage with a JSON body.
 */
function createMockRequest(url: string, body: Record<string, unknown>): IncomingMessage {
    const req = new EventEmitter() as unknown as IncomingMessage;
    req.method = 'POST';
    req.url = url;

    // Simulate body stream in next tick.
    process.nextTick(() => {
        (req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)));
        (req as unknown as EventEmitter).emit('end');
    });

    return req;
}

/**
 * Create a mock ServerResponse that captures output.
 * Exposes a `done` promise that resolves when `end()` is called.
 */
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

/**
 * Configures `mockLoadModule` to resolve `func`'s absolute path to a module
 * exporting a single named function, matching what the real `ssrLoadModule`
 * returns for a real backend-function file.
 */
function mockLoadModuleReturning(func: BackendFunction, fn: (...args: never[]) => unknown) {
    const resolveModule = moduleResolverFor(func, { [func.name]: fn });
    mockLoadModule.mockImplementation(resolveModule);
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
            getApiKeyRequest(),
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

        test('Should handle /__dd/executeAction POST by running the function directly, no bundling, no network call', async () => {
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
            getApiKeyRequest(),
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
            getApiKeyRequest(),
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
                    'DD-API-KEY': 'test-api-key',
                    'DD-APPLICATION-KEY': 'test-app-key',
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

        test('Should call Datadog API with OAuth when configured without API/App keys', async () => {
            mockBuildWithParsedBackend();

            const oauthMiddleware = createDevServerMiddleware(
                mockViteBuild,
                mockLoadModule,
                () => mockFunctions,
                async () => [],
                mockOauthOnlyAuth,
                getOAuthRequest(),
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

            oauthMiddleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(true);
            expect(body.result).toEqual({ data: { ok: true } });
            expect(apiScope.isDone()).toBe(true);
        });

        test('Should return 400 with auth guidance when explicit API-key auth is missing keys', async () => {
            const noKeyMiddleware = createDevServerMiddleware(
                mockViteBuild,
                mockLoadModule,
                () => mockFunctions,
                async () => [],
                mockOauthOnlyAuth,
                undefined,
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
            expect(body.error).toContain('DD_APPS_AUTH_METHOD=oauth');
            expect(body.error).toContain('DD_API_KEY');
            expect(body.error).toContain('DD_APP_KEY');
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
                getApiKeyRequest(),
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
    });

    describe('executeAction handler (local)', () => {
        const middleware = createDevServerMiddleware(
            mockViteBuild,
            mockLoadModule,
            () => mockFunctions,
            async () => [],
            mockAuth,
            getApiKeyRequest(),
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

        test('Should run the function directly in-process and return its result, with no bundling and no network call', async () => {
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

        test('Should work with no auth configured at all, for a function that never calls $.Actions', async () => {
            const noAuthMiddleware = createDevServerMiddleware(
                mockViteBuild,
                mockLoadModule,
                () => mockFunctions,
                async () => [],
                mockOauthOnlyAuth,
                undefined,
                '/project',
                mockLog,
            );
            mockLoadModuleReturning(mockFunctions[0], () => 1);

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            noAuthMiddleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(true);
            expect(body.result).toEqual({ data: 1 });
        });

        test('Should return a clear error when a function calls $.Actions with no auth configured', async () => {
            const noAuthMiddleware = createDevServerMiddleware(
                mockViteBuild,
                mockLoadModule,
                () => mockFunctions,
                async () => [],
                mockOauthOnlyAuth,
                undefined,
                '/project',
                mockLog,
            );
            mockLoadModuleReturning(mockFunctions[0], () =>
                (
                    globalThis as typeof globalThis & { $: { Actions: ActionsProxy } }
                ).$.Actions.slack.chat.postMessage({
                    inputs: { text: 'hi' },
                }),
            );

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
                getApiKeyRequest(),
                '/project',
                mockLog,
            );
            mockLoadModuleReturning(funcWithConnection, () =>
                (
                    globalThis as typeof globalThis & { $: { Actions: ActionsProxy } }
                ).$.Actions.slack.chat.postMessage({
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
            // The action's raw output ({ok, ts}, its own schema, not wrapped
            // by preview-async itself) is what $.Actions.foo.bar() resolves
            // to; the outer {data: ...} comes from the function's own return
            // value going through executeScriptLocally's usual wrapping, not
            // from anything action-specific.
            expect(body.result).toEqual({ data: { ok: true, ts: '123' } });
            expect(apiScope.isDone()).toBe(true);
            expect(capturedBody?.data.attributes.query.properties.spec).toEqual({
                fqn: 'com.datadoghq.slack.chat.postMessage',
                inputs: { text: 'hi' },
                connectionId: 'conn-1',
            });
        });

        test("Should surface a successful $.Actions call's result to the local console", async () => {
            mockLoadModuleReturning(mockFunctions[0], () =>
                (
                    globalThis as typeof globalThis & { $: { Actions: ActionsProxy } }
                ).$.Actions.slack.chat.postMessage({
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
                (
                    globalThis as typeof globalThis & { $: { Actions: ActionsProxy } }
                ).$.Actions.slack.chat.postMessage({
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

        // Guards the priming loadModule call (see handleExecuteAction) — it
        // evaluates the entry's real top-level code before
        // executeScriptLocally's own hang-detection timeout is installed, so
        // a customer module with a hanging top-level await would otherwise
        // wedge this request forever with no bound at all.
        test('Should eventually time out and return a clear error when the priming load never settles', async () => {
            jest.useFakeTimers();
            try {
                mockLoadModule.mockImplementation(
                    () => new Promise(() => {}), // never settles
                );

                const req = createMockRequest('/__dd/executeAction', {
                    functionName: encodeQueryName(mockFunctions[0]),
                    args: [],
                });
                const res = createMockResponse();

                middleware(req, res, jest.fn());
                const doneAssertion = res.done;

                // createMockRequest emits the body via a real process.nextTick,
                // which fake timers don't advance — drain it first so the
                // priming load's own setTimeout is actually scheduled before
                // runAllTimersAsync tries to advance past it.
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

        // Guards getAllowedConnectionIds — it reads every reachable module
        // from disk and transforms it (dev-server-module-graph.ts), with no
        // bound of its own, unlike the sibling priming load right next to it
        // in handleExecuteAction which already has one.
        test('Should eventually time out and return a clear error when getAllowedConnectionIds never settles', async () => {
            jest.useFakeTimers();
            try {
                mockLoadModuleReturning(mockFunctions[0], () => 'done');
                const hangingMiddleware = createDevServerMiddleware(
                    mockViteBuild,
                    mockLoadModule,
                    () => mockFunctions,
                    () => new Promise(() => {}), // never settles
                    mockAuth,
                    getApiKeyRequest(),
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
                getApiKeyRequest(),
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
