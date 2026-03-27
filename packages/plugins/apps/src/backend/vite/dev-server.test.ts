// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createDevServerMiddleware } from '@dd/apps-plugin/backend/vite/dev-server';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import { EventEmitter } from 'events';
import nock from 'nock';

const mockViteBuild = jest.fn();

const DD_SITE = 'datadoghq.com';

const mockFunctions = [
    { name: 'greet', entryPath: '/project/backend/greet.ts' },
    { name: 'compute', entryPath: '/project/backend/compute.ts' },
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
function createMockRequest(url: string, body: Record<string, unknown>) {
    const req = new EventEmitter();
    (req as any).method = 'POST';
    (req as any).url = url;

    // Simulate body stream in next tick.
    process.nextTick(() => {
        req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
    });

    return req as any;
}

/**
 * Create a mock ServerResponse that captures output.
 */
function createMockResponse() {
    let body = '';
    const res = {
        statusCode: 200,
        setHeader: jest.fn(),
        end: jest.fn((data: string) => {
            body = data || '';
        }),
        getBody() {
            return body;
        },
    };
    return res as any;
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
    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        nock.cleanAll();
    });

    describe('createDevServerMiddleware routing', () => {
        const middleware = createDevServerMiddleware(
            mockViteBuild,
            mockFunctions,
            mockAuth,
            '/project',
            mockLog,
        );

        test('Should call next() for non-POST requests', () => {
            const req = { method: 'GET', url: '/__dd/debugBundle' } as any;
            const res = createMockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('Should call next() for unrelated URLs', () => {
            const req = { method: 'POST', url: '/some-other-path' } as any;
            const res = createMockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('Should handle /__dd/debugBundle POST', async () => {
            mockViteBuild.mockResolvedValue(mockBuildResult('// bundled code'));

            const req = createMockRequest('/__dd/debugBundle', { functionName: 'greet' });
            const res = createMockResponse();
            const next = jest.fn();

            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();

            // Wait for async handler to complete.
            await new Promise((resolve) => setTimeout(resolve, 50));

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
                            outputs: { result: 'hello' },
                        },
                    },
                });

            const req = createMockRequest('/__dd/executeAction', {
                functionName: 'greet',
                args: ['world'],
            });
            const res = createMockResponse();
            const next = jest.fn();

            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();

            // Wait for async handler to complete.
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(true);
            expect(body.result).toEqual({ result: 'hello' });
            expect(apiScope.isDone()).toBe(true);
        });
    });

    describe('debugBundle handler', () => {
        const middleware = createDevServerMiddleware(
            mockViteBuild,
            mockFunctions,
            mockAuth,
            '/project',
            mockLog,
        );

        test('Should return 400 for missing functionName', async () => {
            const req = createMockRequest('/__dd/debugBundle', {});
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(res.statusCode).toBe(400);
            expect(JSON.parse(res.getBody()).error).toContain('Missing or invalid functionName');
        });

        test('Should return 404 for unknown function', async () => {
            const req = createMockRequest('/__dd/debugBundle', {
                functionName: 'nonexistent',
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(res.statusCode).toBe(404);
            expect(JSON.parse(res.getBody()).error).toContain('not found');
        });

        test('Should return bundled code as text/plain', async () => {
            mockViteBuild.mockResolvedValue(mockBuildResult('export function main($) {}'));

            const req = createMockRequest('/__dd/debugBundle', { functionName: 'greet' });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(res.statusCode).toBe(200);
            expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain');
            expect(res.getBody()).toContain('export function main($)');
        });

        test('Should call vite.build with configFile: false and write: false', async () => {
            mockViteBuild.mockResolvedValue(mockBuildResult('// code'));

            const req = createMockRequest('/__dd/debugBundle', {
                functionName: 'greet',
                args: [1, 2],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await new Promise((resolve) => setTimeout(resolve, 50));

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
            mockFunctions,
            mockAuth,
            '/project',
            mockLog,
        );

        test('Should return 400 for missing functionName', async () => {
            const req = createMockRequest('/__dd/executeAction', {});
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(res.statusCode).toBe(400);
        });

        test('Should return 404 for unknown function', async () => {
            const req = createMockRequest('/__dd/executeAction', {
                functionName: 'nonexistent',
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(res.statusCode).toBe(404);
        });

        test('Should return 500 when Datadog API fails', async () => {
            mockViteBuild.mockResolvedValue(mockBuildResult('// code'));

            nock(`https://${DD_SITE}`)
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(403, 'Forbidden');

            const req = createMockRequest('/__dd/executeAction', {
                functionName: 'greet',
                args: [],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(res.statusCode).toBe(500);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(false);
            expect(body.error).toContain('Datadog API error');
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
                    data: { attributes: { done: true, outputs: { value: 42 } } },
                });

            const req = createMockRequest('/__dd/executeAction', {
                functionName: 'greet',
                args: [],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(true);
            expect(body.result).toEqual({ value: 42 });
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
                functionName: 'greet',
                args: [],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await new Promise((resolve) => setTimeout(resolve, 100));

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
                    data: { attributes: { done: true, outputs: { ok: true } } },
                });

            const req = createMockRequest('/__dd/executeAction', {
                functionName: 'greet',
                args: [],
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(true);
            expect(body.result).toEqual({ ok: true });
            expect(apiScope.isDone()).toBe(true);
        });
    });
});
