// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createDevServerMiddleware } from '@dd/apps-plugin/vite/dev-server';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import nock from 'nock';

import type { BackendFunction } from '../backend/discovery';
import { encodeQueryName } from '../backend/encodeQueryName';

const mockViteBuild = jest.fn();

const DD_SITE = 'datadoghq.com';

const mockFunctions: BackendFunction[] = [
    {
        relativePath: 'backend/greet',
        name: 'greet',
        absolutePath: '/project/backend/greet.backend.ts',
    },
    {
        relativePath: 'backend/compute',
        name: 'compute',
        absolutePath: '/project/backend/compute.backend.ts',
    },
];

const mockAuth = {
    apiKey: 'test-api-key',
    appKey: 'test-app-key',
    site: 'datadoghq.com',
};

const mockLog = getMockLogger();

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

describe('Dev Server Middleware', () => {
    afterEach(() => {
        nock.cleanAll();
    });

    describe('createDevServerMiddleware routing', () => {
        const middleware = createDevServerMiddleware(
            mockViteBuild,
            () => mockFunctions,
            mockAuth,
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
            mockViteBuild.mockResolvedValue(mockBuildResult('// bundled code'));

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

        test('Should handle /__dd/executeAction POST', async () => {
            mockViteBuild.mockResolvedValue(mockBuildResult('// bundled code'));

            // Mock the Datadog API via nock.
            const apiScope = nock(`https://${DD_SITE}`)
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
            expect(body.result).toEqual({ data: { result: 'hello' } });
            expect(apiScope.isDone()).toBe(true);
        });
    });

    describe('debugBundle handler', () => {
        const middleware = createDevServerMiddleware(
            mockViteBuild,
            () => mockFunctions,
            mockAuth,
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
            mockViteBuild.mockResolvedValue(mockBuildResult('export function main($) {}'));

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
            mockViteBuild.mockResolvedValue(mockBuildResult('// code'));

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

    describe('executeAction handler', () => {
        const middleware = createDevServerMiddleware(
            mockViteBuild,
            () => mockFunctions,
            mockAuth,
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
            mockViteBuild.mockResolvedValue(mockBuildResult('// code'));

            nock(`https://${DD_SITE}`)
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(403, 'Forbidden');

            const req = createMockRequest('/__dd/executeAction', {
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
            mockViteBuild.mockResolvedValue(mockBuildResult('// code'));

            const apiScope = nock(`https://${DD_SITE}`, {
                reqheaders: {
                    'DD-API-KEY': 'test-api-key',
                    'DD-APPLICATION-KEY': 'test-app-key',
                },
            })
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(200, { data: { id: 'receipt-1' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-1')
                .reply(200, {
                    data: { attributes: { done: true, outputs: { data: { value: 42 } } } },
                });

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(true);
            expect(body.result).toEqual({ data: { value: 42 } });
            expect(apiScope.isDone()).toBe(true);
        });

        test('Should handle errors array from long-polling endpoint', async () => {
            mockViteBuild.mockResolvedValue(mockBuildResult('// code'));

            nock(`https://${DD_SITE}`)
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(200, { data: { id: 'receipt-err' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-err')
                .reply(200, {
                    errors: [{ title: 'ExecutionFailed', detail: 'Script threw an error' }],
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
            expect(body.success).toBe(false);
            expect(body.error).toContain('Script threw an error');
        });

        test('Should retry when long-poll returns done: false', async () => {
            mockViteBuild.mockResolvedValue(mockBuildResult('// code'));

            const apiScope = nock(`https://${DD_SITE}`)
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(200, { data: { id: 'receipt-retry' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-retry')
                .reply(200, { data: { attributes: { done: false } } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-retry')
                .reply(200, {
                    data: { attributes: { done: true, outputs: { data: { ok: true } } } },
                });

            const req = createMockRequest('/__dd/executeAction', {
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

    describe('dynamic discovery', () => {
        test('Should not find stale function after re-transform (HMR)', async () => {
            let currentFunctions: BackendFunction[] = [...mockFunctions];
            const middleware = createDevServerMiddleware(
                mockViteBuild,
                () => currentFunctions,
                mockAuth,
                '/project',
                mockLog,
            );

            // Simulate HMR: greet is renamed to greetV2 in the same file.
            currentFunctions = [
                {
                    relativePath: 'backend/greet',
                    name: 'greetV2',
                    absolutePath: '/project/backend/greet.backend.ts',
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
            mockViteBuild.mockResolvedValue(mockBuildResult('// greetV2 code'));

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
