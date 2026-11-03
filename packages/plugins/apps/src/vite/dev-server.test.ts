// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getAuthenticatedRequest } from '@dd/apps-plugin/auth';
import { createBackendStaticChecks } from '@dd/apps-plugin/backend/ast-parsing/run-backend-static-checks';
import { buildBackendFunctions } from '@dd/apps-plugin/vite/build-backend-functions';
import {
    ALLOWED_HOSTS_HINT,
    createViteHostCheck,
} from '@dd/apps-plugin/vite/dev-server-request-guard';
import {
    createDevServerMiddleware,
    DEBUG_BUNDLE_ROUTE,
    DEV_SERVER_ROUTES,
    EXECUTE_ACTION_ROUTE,
    formatRef,
    getRetryDelay,
    MAX_WARNED_REJECTIONS,
    oversizedBundleMessage,
    REJECTION_WARNINGS_CAPPED_MESSAGE,
} from '@dd/apps-plugin/vite/dev-server';
import type {
    LocalExecutionRequest,
    LocalExecutor,
} from '@dd/apps-plugin/vite/local-execution-process';
import { createChildProcessExecutor } from '@dd/apps-plugin/vite/local-execution-process';
import { FunctionThrewError } from '@dd/apps-plugin/vite/local-execution-shared';
import { DEFAULT_TIMEOUT_MS, withTimeout } from '@dd/apps-plugin/vite/local-execution';
import { rmSync } from '@dd/core/helpers/fs';
import type { AuthOptionsWithDefaults, RequestOpts } from '@dd/core/types';
import {
    createMockRequest,
    createMockResponse,
    getMockLogger,
    mockLogFn,
} from '@dd/tests/_jest/helpers/mocks';
import { emitModuleParsed } from '@dd/tests/_jest/helpers/moduleParsed';
import type { IncomingHttpHeaders, IncomingMessage } from 'http';
import nock from 'nock';
import { fork } from 'node:child_process';
import type { InlineConfig } from 'vite';
import { defaultServerConditions } from 'vite';

import { encodeQueryName } from '../backend/encodeQueryName';
import { DEBUG_BUNDLE_PATH } from '../backend/protocol';
import type { BackendFunction } from '../backend/types';
import { DEV_VERIFY_MODE, NODE_BACKEND_RUNTIME } from '../constants';
import type { AppsOptionsWithDefaults } from '../types';

// Spying on the shared core module fails once a sandbox guard makes `fork` non-configurable.
jest.mock('node:child_process', () => {
    const actual = jest.requireActual<typeof import('node:child_process')>('node:child_process');
    return { ...actual, fork: jest.fn(actual.fork) };
});

const mockViteBuild = jest.fn();

/** Stands in for the child process executor, which the local executeAction path hands each call to. */
const mockExecuteLocally = jest.fn();

const DD_API_ORIGIN = 'https://api.datadoghq.com';

const localOnlyHostCheck = createViteHostCheck({ server: { allowedHosts: [] }, preview: {} });

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
// getAuthenticatedRequest reads auth from the environment when called, and API keys take
// precedence over the OAuth token, so they must stay unset for the bearer path.
const TEST_OAUTH_TOKEN = 'test-oauth-token';
process.env.DD_OAUTH_ACCESS_TOKEN = TEST_OAUTH_TOKEN;
const testAuthenticatedRequest = getAuthenticatedRequest();

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

function mockBuildWithParsedBackend(code = '// code') {
    mockViteBuild.mockImplementation(async (config) => {
        const emits = mockFunctions.map((func) =>
            emitModuleParsed(
                config,
                func.absolutePath,
                `export function ${func.name}() { return null; }`,
            ),
        );
        await Promise.all(emits);
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

/** Has `mockExecuteLocally` hydrate `$` through the request, as the real executor does, then return `fn`'s result. */
function mockExecutorReturning(fn: (...args: unknown[]) => unknown) {
    mockExecuteLocally.mockImplementation(async (request: LocalExecutionRequest) => {
        await request.getRuntimeContext();
        return { data: await fn(...request.args) };
    });
}

/** The real executor, for checks that end before a call's process starts; a fork fails the test. */
function createTestExecutor(): LocalExecutor {
    return createChildProcessExecutor({
        invokeChannel: { handleInvoke: async () => ({}) },
        projectRoot: '/project',
        childEntryPath: '/nonexistent/local-execution-child.mjs',
        moduleRunnerPath: '/nonexistent/module-runner.js',
        readRoots: [],
        denyPatterns: [],
        restrictModuleLoads: true,
        resolveModule: async () => undefined,
        log: mockLog,
    });
}

/** Stands in for a call whose backend function makes one `$.Actions.slack.chat.postMessage` call. */
function postMessageExecutor(connectionId: string | undefined): LocalExecutor {
    return async ({ executeAction }) => {
        const inputs = { text: 'hi' };
        const data = await executeAction(
            'com.datadoghq.slack.chat.postMessage',
            inputs,
            connectionId,
        );
        return { data };
    };
}

function createDeferred() {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
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

type CreateDevServerMiddlewareArgs = Parameters<typeof createDevServerMiddleware>;

/** Builds a middleware with the common test defaults, so each test only names the argument(s) it's actually varying. `doAuthenticatedRequest` distinguishes "omitted" from "explicitly undefined" (the no-auth tests) via `in`, since `?? testAuthenticatedRequest` couldn't tell them apart. */
function createTestMiddleware(
    overrides: {
        viteBuild?: CreateDevServerMiddlewareArgs[0];
        getBackendFunctions?: CreateDevServerMiddlewareArgs[1];
        getAllowedConnectionIds?: CreateDevServerMiddlewareArgs[2];
        auth?: CreateDevServerMiddlewareArgs[3];
        doAuthenticatedRequest?: CreateDevServerMiddlewareArgs[4];
        longPolling?: CreateDevServerMiddlewareArgs[5];
        projectRoot?: CreateDevServerMiddlewareArgs[6];
        log?: CreateDevServerMiddlewareArgs[7];
        runStaticChecks?: CreateDevServerMiddlewareArgs[8];
        mode?: CreateDevServerMiddlewareArgs[9];
        isHostAllowed?: CreateDevServerMiddlewareArgs[10];
        serverConditions?: CreateDevServerMiddlewareArgs[11];
        executeLocally?: CreateDevServerMiddlewareArgs[12];
    } = {},
): ReturnType<typeof createDevServerMiddleware> {
    return createDevServerMiddleware(
        overrides.viteBuild ?? mockViteBuild,
        overrides.getBackendFunctions ?? (() => mockFunctions),
        overrides.getAllowedConnectionIds ?? (async () => []),
        overrides.auth ?? mockAuth,
        'doAuthenticatedRequest' in overrides
            ? overrides.doAuthenticatedRequest
            : testAuthenticatedRequest,
        overrides.longPolling ?? mockLongPolling,
        overrides.projectRoot ?? '/project',
        overrides.log ?? mockLog,
        overrides.runStaticChecks ?? createBackendStaticChecks(overrides.log ?? mockLog),
        overrides.mode ?? 'development',
        overrides.isHostAllowed ?? localOnlyHostCheck,
        overrides.serverConditions ?? defaultServerConditions,
        overrides.executeLocally ?? mockExecuteLocally,
    );
}

describe('Dev Server Middleware', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockViteBuild.mockReset();
        mockExecuteLocally.mockReset();
    });

    afterEach(() => {
        nock.cleanAll();
    });

    describe('createDevServerMiddleware routing', () => {
        const middleware = createTestMiddleware();

        test('Should call next() for non-POST requests', () => {
            const req = { method: 'GET', url: DEBUG_BUNDLE_PATH } as unknown as IncomingMessage;
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

            const req = createMockRequest(DEBUG_BUNDLE_PATH, {
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
            mockExecutorReturning((arg) => arg);

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

        test('Should route /__dd/executeAction to the cloud path when the dev server was started in dev-verify mode', async () => {
            const verifyModeMiddleware = createTestMiddleware({ mode: DEV_VERIFY_MODE });

            mockBuildWithParsedBackend();

            const apiScope = nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(200, { data: { id: 'receipt-456' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-456')
                .reply(200, {
                    data: {
                        attributes: {
                            done: true,
                            outputs: { data: { result: 'via cloud' } },
                        },
                    },
                });

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: ['world'],
            });
            const res = createMockResponse();
            const next = jest.fn();

            verifyModeMiddleware(req, res, next);
            expect(next).not.toHaveBeenCalled();

            await res.done;

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.getBody());
            expect(body.success).toBe(true);
            expect(body.result).toEqual({ data: { result: 'via cloud' } });
            expect(apiScope.isDone()).toBe(true);
            expect(mockExecuteLocally).not.toHaveBeenCalled();
        });
    });

    describe('createDevServerMiddleware request guard', () => {
        const routes = [...DEV_SERVER_ROUTES];
        const rejections = [
            {
                description: 'a cross-site Origin',
                headers: { origin: 'https://attacker.example' },
                expectedStatus: 403,
            },
            {
                description: 'a host Vite would not serve',
                headers: {
                    host: 'attacker.example:5173',
                    origin: 'http://attacker.example:5173',
                },
                expectedStatus: 403,
            },
            {
                description: 'a text/plain body',
                headers: { 'content-type': 'text/plain' },
                expectedStatus: 415,
            },
        ];
        const cases = routes.flatMap((route) =>
            rejections.map((rejection) => ({ route, ...rejection })),
        );

        test.each(cases)(
            'Should reject $route with $expectedStatus for $description before handling it',
            async ({ route, headers, expectedStatus }) => {
                const middleware = createTestMiddleware();
                const functionName = encodeQueryName(mockFunctions[0]);
                const req = createMockRequest(route, { functionName, args: [] }, headers);
                const res = createMockResponse();
                const next = jest.fn();

                middleware(req, res, next);
                await res.done;

                const rawBody = res.getBody();
                const body = JSON.parse(rawBody);

                expect(res.statusCode).toBe(expectedStatus);
                expect(body.success).toBe(false);
                expect(next).not.toHaveBeenCalled();
                expect(mockViteBuild).not.toHaveBeenCalled();
                expect(mockExecuteLocally).not.toHaveBeenCalled();
                const routeMessage = expect.stringContaining(route);
                expect(mockLogFn).toHaveBeenCalledWith(routeMessage, 'warn');
            },
        );

        test('Should leave other /__dd paths to the next middleware', () => {
            const middleware = createTestMiddleware();
            const req = createMockRequest(
                '/__dd/sw.js',
                {},
                { origin: 'https://attacker.example' },
            );
            const res = createMockResponse();
            const next = jest.fn();

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.end).not.toHaveBeenCalled();
        });

        test('Should serve a request proxied under an allowed preview proxy host', async () => {
            mockBuildWithParsedBackend();
            const previewHost = 'app-5173.preview.example';
            const previewHostCheck = createViteHostCheck({
                server: { allowedHosts: ['.preview.example'] },
                preview: {},
            });
            const middleware = createTestMiddleware({
                isHostAllowed: previewHostCheck,
            });
            const functionName = encodeQueryName(mockFunctions[0]);
            const req = createMockRequest(
                DEBUG_BUNDLE_ROUTE,
                { functionName },
                { host: previewHost, origin: `https://${previewHost}` },
            );
            const res = createMockResponse();
            const next = jest.fn();

            middleware(req, res, next);
            await res.done;

            expect(res.statusCode).toBe(200);
            expect(next).not.toHaveBeenCalled();
        });
    });

    describe('createDevServerMiddleware refusal logging', () => {
        async function sendRequest(
            middleware: ReturnType<typeof createDevServerMiddleware>,
            headers: IncomingHttpHeaders,
        ): Promise<void> {
            const functionName = encodeQueryName(mockFunctions[0]);
            const req = createMockRequest(
                EXECUTE_ACTION_ROUTE,
                { functionName, args: [] },
                headers,
            );
            const res = createMockResponse();
            const next = jest.fn();

            middleware(req, res, next);
            await res.done;
        }

        function refusalLogLevels(): string[] {
            return mockLogFn.mock.calls
                .filter(([text]) => String(text).includes(EXECUTE_ACTION_ROUTE))
                .map(([, level]) => level);
        }

        const tunnelHost = { host: 'tunnel.example:5173' };
        const lanHost = { host: 'lan-box:5173' };
        const crossOrigin = { origin: 'https://attacker.example' };
        const cases = [
            {
                description: 'warn the first time a host is refused and log repeats at debug',
                requests: [tunnelHost, tunnelHost, tunnelHost],
                expectedLevels: ['warn', 'debug', 'debug'],
            },
            {
                description: 'warn once for each refused hostname, whatever its port',
                requests: [
                    tunnelHost,
                    lanHost,
                    tunnelHost,
                    lanHost,
                    { host: 'tunnel.example:5174' },
                ],
                expectedLevels: ['warn', 'warn', 'debug', 'debug', 'debug'],
            },
            {
                description: 'warn once for each distinct HTTP/2 :authority',
                requests: [
                    { host: undefined, ':authority': 'tunnel.example:5173' },
                    { host: undefined, ':authority': 'lan-box:5173' },
                    { host: undefined, ':authority': 'tunnel.example:5173' },
                ],
                expectedLevels: ['warn', 'warn', 'debug'],
            },
            {
                description: 'warn once for a missing Host, whether absent or empty',
                requests: [{ host: undefined }, { host: '' }],
                expectedLevels: ['warn', 'debug'],
            },
            {
                description: 'warn once for a refusal whose message is the same from another host',
                requests: [crossOrigin, { ...crossOrigin, host: '127.0.0.1:5173' }],
                expectedLevels: ['warn', 'debug'],
            },
            {
                description: 'warn again when the same host is refused for a different reason',
                requests: [crossOrigin, { 'content-type': 'text/plain' }, crossOrigin],
                expectedLevels: ['warn', 'warn', 'debug'],
            },
        ];

        test.each(cases)('Should $description', async ({ requests, expectedLevels }) => {
            const middleware = createTestMiddleware();

            for (const headers of requests) {
                // eslint-disable-next-line no-await-in-loop
                await sendRequest(middleware, headers);
            }

            const levels = refusalLogLevels();
            expect(levels).toEqual(expectedLevels);
        });

        test('Should say once that warnings stop after the maximum number of warned rejections', async () => {
            const middleware = createTestMiddleware();
            const hostCount = MAX_WARNED_REJECTIONS + 2;

            for (let index = 0; index < hostCount; index++) {
                // eslint-disable-next-line no-await-in-loop
                await sendRequest(middleware, { host: `tunnel-${index}.example:5173` });
            }
            await sendRequest(middleware, { host: 'tunnel-0.example:5173' });

            const expectedLevels = [
                ...Array(MAX_WARNED_REJECTIONS + 1).fill('warn'),
                'debug',
                'debug',
            ];
            const levels = refusalLogLevels();
            expect(levels).toEqual(expectedLevels);
            const capNotices = mockLogFn.mock.calls.filter(([text]) =>
                String(text).endsWith(REJECTION_WARNINGS_CAPPED_MESSAGE),
            );
            const firstUnwarnedHost = expect.stringContaining(
                `tunnel-${MAX_WARNED_REJECTIONS}.example`,
            );
            expect(capNotices).toEqual([[firstUnwarnedHost, 'warn']]);
        });

        test('Should track warned hosts per middleware instance', async () => {
            const firstMiddleware = createTestMiddleware();
            const secondMiddleware = createTestMiddleware();

            await sendRequest(firstMiddleware, tunnelHost);
            await sendRequest(secondMiddleware, tunnelHost);

            const levels = refusalLogLevels();
            expect(levels).toEqual(['warn', 'warn']);
        });

        test('Should warn with the actionable message and without request credentials', async () => {
            const credential = 'do-not-log-credential';
            const middleware = createTestMiddleware();

            await sendRequest(middleware, {
                ...tunnelHost,
                cookie: `session=${credential}`,
                authorization: `Bearer ${credential}`,
            });

            const loggedText = mockLogFn.mock.calls.map(([text]) => String(text)).join('\n');
            const [hostWarning] = mockLogFn.mock.calls.find(([, level]) => level === 'warn') ?? [];
            expect(String(hostWarning)).toContain('"tunnel.example"');
            expect(String(hostWarning).split(ALLOWED_HOSTS_HINT)[1]).toBe('');
            expect(loggedText).not.toContain(credential);
        });
    });

    describe('debugBundle handler', () => {
        const middleware = createTestMiddleware();

        test('Should return 400 for missing functionRef', async () => {
            const req = createMockRequest(DEBUG_BUNDLE_PATH, {});
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(400);
            expect(JSON.parse(res.getBody()).error).toContain('Missing or invalid functionName');
        });

        test('Should return 404 for unknown function', async () => {
            const req = createMockRequest(DEBUG_BUNDLE_PATH, {
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

            const req = createMockRequest(DEBUG_BUNDLE_PATH, {
                functionName: encodeQueryName(mockFunctions[0]),
            });
            const res = createMockResponse();

            middleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain');
            expect(res.getBody()).toContain('export function main($)');
        });

        const plainTextCases = [
            { description: 'no Accept header', headers: {} },
            { description: 'a wildcard Accept header', headers: { accept: '*/*' } },
            { description: 'a text/plain Accept header', headers: { accept: 'text/plain' } },
            {
                description: 'an Accept header that refuses JSON with q=0',
                headers: { accept: 'application/json;q=0, text/plain' },
            },
        ];

        test.each(plainTextCases)(
            'Should keep returning plain-text code for a request with $description',
            async ({ headers }) => {
                mockBuildWithParsedBackend('export function main($) {}');

                const functionName = encodeQueryName(mockFunctions[0]);
                const req = createMockRequest(DEBUG_BUNDLE_PATH, { functionName }, headers);
                const res = createMockResponse();

                const next = jest.fn();
                middleware(req, res, next);
                await res.done;

                expect(res.statusCode).toBe(200);
                expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain');
                const body = res.getBody();
                expect(body).toBe('export function main($) {}');
            },
        );

        const jsonAcceptCases = [
            { description: 'application/json', accept: 'application/json' },
            { description: 'application/json with parameters', accept: 'application/json; q=1' },
            { description: 'mixed-case application/json', accept: 'Application/JSON' },
            {
                description: 'application/json among other media types',
                accept: 'text/html, application/json;q=0.9',
            },
        ];

        test.each(jsonAcceptCases)(
            'Should return code and no connection IDs as JSON for an Accept header of $description',
            async ({ accept }) => {
                mockBuildWithParsedBackend('export function main($) {}');

                const functionName = encodeQueryName(mockFunctions[0]);
                const req = createMockRequest(DEBUG_BUNDLE_PATH, { functionName }, { accept });
                const res = createMockResponse();

                const next = jest.fn();
                middleware(req, res, next);
                await res.done;

                expect(res.statusCode).toBe(200);
                expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
                const rawBody = res.getBody();
                const body = JSON.parse(rawBody);
                expect(body).toEqual({
                    code: 'export function main($) {}',
                    allowedConnectionIds: [],
                });
            },
        );

        test('Should return the connection IDs the bundled function and its helpers use as JSON', async () => {
            const helperId = '/project/backend/helpers/slack.js';
            const entryCode = `
                import { request } from '@datadog/action-catalog/http/http';
                import { notify } from './helpers/slack.js';
                export function greet() {
                    request({ connectionId: 'conn-http', inputs: {} });
                    return notify();
                }
            `;
            const helperCode = `
                import { sendSlackMessage } from '@datadog/action-catalog';
                export function notify() {
                    return sendSlackMessage({ connectionId: 'conn-slack', inputs: {} });
                }
            `;
            mockViteBuild.mockImplementation(async (config) => {
                await emitModuleParsed(config, mockFunctions[0].absolutePath, entryCode);
                await emitModuleParsed(config, helperId, helperCode);
                return mockBuildResult('// bundled');
            });

            const functionName = encodeQueryName(mockFunctions[0]);
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
            expect(body).toEqual({
                code: '// bundled',
                allowedConnectionIds: ['conn-http', 'conn-slack'],
            });
        });

        test('Should return a JSON 404 for an unknown query name when JSON is requested', async () => {
            const req = createMockRequest(
                DEBUG_BUNDLE_PATH,
                { functionName: 'nonexistent.nonexistent' },
                { accept: 'application/json' },
            );
            const res = createMockResponse();

            const next = jest.fn();
            middleware(req, res, next);
            await res.done;

            expect(res.statusCode).toBe(404);
            expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
            const rawBody = res.getBody();
            const body = JSON.parse(rawBody);
            expect(body).toEqual({
                success: false,
                error: 'Backend function "nonexistent.nonexistent" not found',
            });
            expect(mockViteBuild).not.toHaveBeenCalled();
        });

        test('Should reject a bundle whose imported helper module has a restricted import or global', async () => {
            // Emits moduleParsed for both the entry and a helper module, to prove the static-checks plugin covers the helper too, not just the entry file.
            mockViteBuild.mockImplementation(async (config) => {
                await emitModuleParsed(
                    config,
                    mockFunctions[0].absolutePath,
                    `export function ${mockFunctions[0].name}() { return null; }`,
                );
                await emitModuleParsed(
                    config,
                    '/project/backend/helpers/secrets.ts',
                    "export function readSecret() { return Deno.readTextFileSync('/etc/passwd'); }",
                );
                return mockBuildResult('// code');
            });

            const encodedFunctionName = encodeQueryName(mockFunctions[0]);
            const req = createMockRequest(DEBUG_BUNDLE_PATH, {
                functionName: encodedFunctionName,
            });
            const res = createMockResponse();
            const next = jest.fn();

            middleware(req, res, next);
            await res.done;

            expect(res.statusCode).toBe(500);
            const responseText = res.getBody();
            const body = JSON.parse(responseText);
            expect(body.error).toContain(`"Deno" is not available in the ${NODE_BACKEND_RUNTIME}`);
        });

        test('Should call vite.build with configFile: false and write: false', async () => {
            mockBuildWithParsedBackend();

            const req = createMockRequest(DEBUG_BUNDLE_PATH, {
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
                    }),
                }),
            );
        });

        test('Should bundle with the minify and keepNames settings an upload uses', async () => {
            const [func] = mockFunctions;
            const uploadBuild = jest.fn();
            uploadBuild.mockImplementation(async (config) => {
                const source = `export function ${func.name}() { return null; }`;
                await emitModuleParsed(config, func.absolutePath, source);
                return { output: [] };
            });
            const upload = await buildBackendFunctions(
                uploadBuild,
                [func],
                '/project',
                mockLog,
                createBackendStaticChecks(mockLog),
            );
            rmSync(upload.outDir);
            mockBuildWithParsedBackend();
            const functionName = encodeQueryName(func);
            const req = createMockRequest('/__dd/debugBundle', { functionName });
            const res = createMockResponse();
            const next = jest.fn();

            middleware(req, res, next);
            await res.done;

            const [[uploadConfig]] = uploadBuild.mock.calls;
            const [[devConfig]] = mockViteBuild.mock.calls;
            const minifySettings = (config: InlineConfig) => {
                const output = config.build?.rollupOptions?.output;
                const hasKeepNames = output && !Array.isArray(output) && 'keepNames' in output;
                return {
                    esbuildKeepNames: config.esbuild ? config.esbuild.keepNames : undefined,
                    minify: config.build?.minify,
                    outputKeepNames: hasKeepNames ? output.keepNames : undefined,
                };
            };
            const devSettings = minifySettings(devConfig);
            const uploadSettings = minifySettings(uploadConfig);
            expect(devSettings).toEqual(uploadSettings);
            expect(devSettings).toEqual({
                esbuildKeepNames: true,
                minify: true,
                outputKeepNames: true,
            });
        });
    });

    describe('executeActionViaCloud handler', () => {
        const middleware = createTestMiddleware();

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
            const noAuthMiddleware = createTestMiddleware({ doAuthenticatedRequest: undefined });

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

            const bearerMiddleware = createTestMiddleware({
                doAuthenticatedRequest: getAuthenticatedRequest(),
            });

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
            const noKeyMiddleware = createTestMiddleware({ doAuthenticatedRequest: undefined });

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
            const middlewareWithAllowlist = createTestMiddleware({
                getBackendFunctions: () => functionsWithAllowlist,
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
                await emitModuleParsed(
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

            const singleAttemptMiddleware = createTestMiddleware({
                longPolling: { ...mockLongPolling, maxRetries: 1 },
            });

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
            const stallingMiddleware = createTestMiddleware({
                longPolling: { ...mockLongPolling, timeoutMs: 100 },
            });

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

    describe('oversized bundle rejection', () => {
        const BUNDLED_CODE = 'export async function main($) { return "😀"; }';
        const BUNDLE_LENGTH = Array.from(BUNDLED_CODE).length;
        const SCRIPT_LIMIT = BUNDLE_LENGTH - 1;
        const SCRIPT_REJECTION = `.script: length must be <= ${SCRIPT_LIMIT}, but got ${BUNDLE_LENGTH}`;

        // Staging's answer to a jsFunctionWithActions script over the limit, with its numbers swapped in.
        function inputRejection(fieldError: string) {
            return {
                errors: [
                    {
                        status: '400',
                        id: 'c391b376-bfec-4dd4-b415-cc9cd0fc4aa7',
                        code: 'INVALID_INPUT_PARAMETER',
                        title: 'error running query',
                        detail: `input parameter validation error: 1 error occurred:\n\t* ${fieldError}\n\n`,
                    },
                ],
            };
        }

        function rejectSubmit(body: ReturnType<typeof inputRejection>, times = 1) {
            return nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async')
                .times(times)
                .reply(400, body);
        }

        async function callViaCloud(
            middleware: ReturnType<typeof createDevServerMiddleware>,
            func = mockFunctions[0],
            url = '/__dd/executeActionViaCloud',
        ) {
            const functionName = encodeQueryName(func);
            const req = createMockRequest(url, { functionName, args: [] });
            const res = createMockResponse();
            const next = jest.fn();
            middleware(req, res, next);
            await res.done;
            const responseBody = res.getBody();
            const body = JSON.parse(responseBody);
            return { statusCode: res.statusCode, body };
        }

        function getWarnings() {
            return mockLogFn.mock.calls
                .filter(([, level]) => level === 'warn')
                .map(([text]) => text);
        }

        test('Should name the function, its size, Datadog answer and how to shrink it', () => {
            const message = oversizedBundleMessage('src/a/run', 12, SCRIPT_REJECTION);

            expect(message).toContain('Backend function "src/a/run" is larger than production');
            expect(message).toContain('its minified bundle is 12 characters');
            expect(message).toContain(`"${SCRIPT_REJECTION}"`);
            expect(message).toContain('splitting the function or moving large data out of it');
        });

        const routeCases = [
            { route: '/__dd/executeActionViaCloud', mode: 'development' },
            { route: '/__dd/executeAction', mode: DEV_VERIFY_MODE },
        ];
        test.each(routeCases)(
            'Should answer $route in $mode mode with a 413 that explains the size',
            async ({ route, mode }) => {
                mockBuildWithParsedBackend(BUNDLED_CODE);
                const rejection = inputRejection(SCRIPT_REJECTION);
                const scope = rejectSubmit(rejection);
                const middleware = createTestMiddleware({ mode });

                const { statusCode, body } = await callViaCloud(
                    middleware,
                    mockFunctions[0],
                    route,
                );
                const isDone = scope.isDone();

                const displayName = formatRef(mockFunctions[0]);
                const expected = oversizedBundleMessage(
                    displayName,
                    BUNDLE_LENGTH,
                    SCRIPT_REJECTION,
                );
                expect(isDone).toBe(true);
                expect(statusCode).toBe(413);
                const warnings = getWarnings();
                expect(body).toEqual({ success: false, error: expected });
                expect(warnings).toEqual([expected]);
            },
        );

        test('Should warn once per function, however often it is rejected', async () => {
            mockBuildWithParsedBackend(BUNDLED_CODE);
            const rejection = inputRejection(SCRIPT_REJECTION);
            const scope = rejectSubmit(rejection, 3);
            const middleware = createTestMiddleware();

            const first = await callViaCloud(middleware, mockFunctions[0]);
            const second = await callViaCloud(middleware, mockFunctions[0]);
            const other = await callViaCloud(middleware, mockFunctions[1]);
            const isDone = scope.isDone();
            const warnings = getWarnings();

            const [firstName, otherName] = mockFunctions.map(formatRef);
            const firstWarning = oversizedBundleMessage(firstName, BUNDLE_LENGTH, SCRIPT_REJECTION);
            const otherWarning = oversizedBundleMessage(otherName, BUNDLE_LENGTH, SCRIPT_REJECTION);
            expect(isDone).toBe(true);
            expect([first.statusCode, second.statusCode, other.statusCode]).toEqual([
                413, 413, 413,
            ]);
            expect(warnings).toEqual([firstWarning, otherWarning]);
        });

        const passthroughCases = [
            {
                scenario: 'another input field is rejected',
                body: inputRejection('.allowedConnectionIds: expected array'),
            },
            {
                scenario: 'a nested field named script is rejected',
                body: inputRejection('.context.script: expected string'),
            },
            {
                scenario: 'the error code is not an input-parameter rejection',
                body: {
                    errors: [{ ...inputRejection(SCRIPT_REJECTION).errors[0], code: 'OTHER' }],
                },
            },
        ];
        test.each(passthroughCases)(
            'Should pass the error on unchanged when $scenario',
            async ({ body: rejection }) => {
                mockBuildWithParsedBackend(BUNDLED_CODE);
                const scope = rejectSubmit(rejection);
                const middleware = createTestMiddleware();

                const { statusCode, body } = await callViaCloud(middleware);
                const isDone = scope.isDone();
                const warnings = getWarnings();

                expect(isDone).toBe(true);
                expect(statusCode).toBe(500);
                expect(body.error).toContain('HTTP 400');
                expect(body.error).not.toContain('larger than production');
                expect(warnings).toEqual([]);
            },
        );
    });

    describe('executeAction handler (local)', () => {
        const forkMock = jest.mocked(fork);
        beforeEach(() => {
            mockRuntimeContextHydration();
        });

        const middleware = createTestMiddleware({ executeLocally: createTestExecutor() });

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

        test('Should hand the call, with its timeout and long polling, to the local executor', async () => {
            const executeLocally = jest.fn().mockResolvedValue({ data: 'from child' });
            const childMiddleware = createTestMiddleware({ executeLocally });
            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [21],
            });
            const res = createMockResponse();

            childMiddleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            expect(JSON.parse(res.getBody()).result).toEqual({ data: 'from child' });
            expect(executeLocally).toHaveBeenCalledWith(
                expect.objectContaining({
                    func: mockFunctions[0],
                    args: [21],
                    timeoutMs: DEFAULT_TIMEOUT_MS,
                    longPolling: mockLongPolling,
                }),
            );
        });

        test('Should send one runtime context query for calls that need it at the same time', async () => {
            nock.cleanAll();
            const hydration = mockRuntimeContextHydration(1);
            const callCount = 3;
            const allStarted = createDeferred();
            let started = 0;
            const executeLocally = jest.fn(async (request: LocalExecutionRequest) => {
                started += 1;
                if (started === callCount) {
                    allStarted.resolve();
                }
                await withTimeout(allStarted.promise, 5000, 'Waiting for every call to start');
                const data = await request.getRuntimeContext();
                return { data };
            });
            const childMiddleware = createTestMiddleware({ executeLocally });
            const responses = Array.from({ length: callCount }, () => {
                const req = createMockRequest('/__dd/executeAction', {
                    functionName: encodeQueryName(mockFunctions[0]),
                    args: [],
                });
                const res = createMockResponse();
                childMiddleware(req, res, jest.fn());
                return res;
            });
            const allDone = responses.map((res) => res.done);
            await Promise.all(allDone);

            for (const res of responses) {
                expect(res.statusCode).toBe(200);
                expect(JSON.parse(res.getBody()).result).toEqual({
                    data: previewRuntimeContext,
                });
            }
            expect(hydration.isDone()).toBe(true);
        });

        test('Should query the runtime context again for a call that starts after the last query ended', async () => {
            nock.cleanAll();
            const hydration = mockRuntimeContextHydration(2);
            const executeLocally = jest.fn(async (request: LocalExecutionRequest) => {
                const data = await request.getRuntimeContext();
                return { data };
            });
            const childMiddleware = createTestMiddleware({ executeLocally });
            const callAndWait = async () => {
                const req = createMockRequest('/__dd/executeAction', {
                    functionName: encodeQueryName(mockFunctions[0]),
                    args: [],
                });
                const res = createMockResponse();
                childMiddleware(req, res, jest.fn());
                await res.done;
                return res.statusCode;
            };

            expect(await callAndWait()).toBe(200);
            expect(await callAndWait()).toBe(200);
            expect(hydration.isDone()).toBe(true);
        });

        test("Should reject a malformed hydrated identity before starting a call's process without exposing the response body", async () => {
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
            expect(forkMock).not.toHaveBeenCalled();
            expect(mockLogFn).not.toHaveBeenCalledWith(
                expect.stringContaining('must-not-appear'),
                expect.anything(),
            );
        });

        test("Should reject hydration outputs with no data field before starting a call's process", async () => {
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
            expect(forkMock).not.toHaveBeenCalled();
        });

        test('Should bound stalled runtime-context hydration when the request ignores abort so later local executions are not wedged', async () => {
            jest.useFakeTimers();
            try {
                nock.cleanAll();
                const executeLocally = createTestExecutor();
                let hydrationSignal: AbortSignal | undefined;
                const recoveringRuntimeContextRequest = makeImmediateRuntimeContextRequest();
                const nonAbortableRuntimeContextRequest = <T>(
                    options: Omit<RequestOpts, 'auth'>,
                ) => {
                    if (hydrationSignal) {
                        return recoveringRuntimeContextRequest(options) as Promise<T>;
                    }
                    hydrationSignal = options.signal;
                    // Models doRequest sleeping in async-retry backoff: the signal is aborted,
                    // but the request promise does not settle until the retry timer wakes up.
                    return new Promise<T>(() => {});
                };
                const hangingHydrationMiddleware = createDevServerMiddleware(
                    mockViteBuild,
                    () => mockFunctions,
                    async () => {
                        throw new Error('reached the connection lookup');
                    },
                    mockAuth,
                    nonAbortableRuntimeContextRequest,
                    mockLongPolling,
                    '/project',
                    mockLog,
                    createBackendStaticChecks(mockLog),
                    'development',
                    localOnlyHostCheck,
                    defaultServerConditions,
                    executeLocally,
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
                expect(hydrationSignal?.aborted).toBe(true);
                expect(forkMock).not.toHaveBeenCalled();

                // The same dev server reaching the connection lookup shows the timed-out query no
                // longer holds the shared runtime context.
                const recoveringReq = createMockRequest('/__dd/executeAction', {
                    functionName: encodeQueryName(mockFunctions[0]),
                    args: [],
                });
                const recoveringRes = createMockResponse();

                hangingHydrationMiddleware(recoveringReq, recoveringRes, jest.fn());
                const recoveringDone = recoveringRes.done;
                await jest.advanceTimersByTimeAsync(0);
                await recoveringDone;

                expect(recoveringRes.statusCode).toBe(500);
                const recoveringBody = JSON.parse(recoveringRes.getBody());
                expect(recoveringBody.error).toContain('reached the connection lookup');
            } finally {
                jest.useRealTimers();
            }
        });

        test('Should reject a request with no auth configured upfront, even for a function that never calls $.Actions — matching production, which authenticates before any backend code runs', async () => {
            const noAuthMiddleware = createTestMiddleware({ doAuthenticatedRequest: undefined });

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
            const middlewareWithConnection = createTestMiddleware({
                getBackendFunctions: () => [funcWithConnection, mockFunctions[1]],
                executeLocally: postMessageExecutor('conn-1'),
            });

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
            // The action's raw output ({ok, ts}) is what $.Actions.foo.bar() resolves to.
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
            const middlewareWithEmptyConnection = createTestMiddleware({
                getBackendFunctions: () => [funcWithEmptyConnection, mockFunctions[1]],
                executeLocally: postMessageExecutor(''),
            });

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

        test("Should log a successful $.Actions call's fqn, duration, and response size at debug level without logging the response body", async () => {
            const actionMiddleware = createTestMiddleware({
                executeLocally: postMessageExecutor(undefined),
            });

            const responseSentinel = 'monitor-creator@example.com';
            const actionOutputs = { ok: true, creator: responseSentinel, name: 'café' };
            const actionDelayMs = 50;
            // Timers can fire a few ms early relative to Date.now().
            const timerJitterMs = 10;
            nock(DD_API_ORIGIN)
                .post('/api/v2/app-builder/queries/preview-async')
                .reply(200, { data: { id: 'receipt-success' } })
                .get('/api/v2/app-builder/queries/execution-long-polling/receipt-success')
                .delay(actionDelayMs)
                .reply(200, {
                    data: { attributes: { done: true, outputs: actionOutputs } },
                });

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            actionMiddleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(200);
            const serializedOutputs = JSON.stringify(actionOutputs);
            const expectedByteLength = Buffer.byteLength(serializedOutputs);
            const successLine = mockLogFn.mock.calls.find(
                ([text, level]) =>
                    level === 'debug' && String(text).startsWith('$.Actions call to'),
            )?.[0];
            const successMatch = String(successLine).match(
                /^\$\.Actions call to "com\.datadoghq\.slack\.chat\.postMessage" succeeded in (\d+)ms \((\d+) bytes\)$/,
            );
            expect(successMatch).not.toBeNull();
            const loggedDurationMs = Number(successMatch?.[1]);
            const loggedByteLength = Number(successMatch?.[2]);
            expect(loggedDurationMs).toBeGreaterThanOrEqual(actionDelayMs - timerJitterMs);
            expect(loggedByteLength).toBe(expectedByteLength);
            expect(mockLogFn).not.toHaveBeenCalledWith(
                expect.stringContaining('succeeded'),
                'info',
            );
            const loggedTexts = mockLogFn.mock.calls.map(([text]) => String(text));
            const allLoggedText = loggedTexts.join('\n');
            expect(allLoggedText).not.toContain(responseSentinel);
        });

        test("Should surface a failed $.Actions call's error detail to the local console", async () => {
            const actionMiddleware = createTestMiddleware({
                executeLocally: postMessageExecutor(undefined),
            });

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

            actionMiddleware(req, res, jest.fn());
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

        describe('What a failed $.Actions call rejects with, as in a deployed app', () => {
            const catchingPostMessage: LocalExecutor = async ({ executeAction }) => {
                try {
                    await executeAction(
                        'com.datadoghq.slack.chat.postMessage',
                        { text: 'hi' },
                        undefined,
                    );
                    return { data: 'no error' };
                } catch (error) {
                    return { data: { type: typeof error, value: error } };
                }
            };
            const runAndReadData = async () => {
                const actionMiddleware = createTestMiddleware({
                    executeLocally: catchingPostMessage,
                });
                const req = createMockRequest('/__dd/executeAction', {
                    functionName: encodeQueryName(mockFunctions[0]),
                    args: [],
                });
                const res = createMockResponse();
                actionMiddleware(req, res, jest.fn());
                await res.done;
                return JSON.parse(res.getBody()).result.data;
            };
            const mockActionErrors = (errors: Array<{ detail?: string; title?: string }>) =>
                nock(DD_API_ORIGIN)
                    .post('/api/v2/app-builder/queries/preview-async')
                    .reply(200, { data: { id: 'receipt-action-failure' } })
                    .get(
                        '/api/v2/app-builder/queries/execution-long-polling/receipt-action-failure',
                    )
                    .reply(200, { errors });

            test("Should reject with the platform's bare error detail as a string", async () => {
                mockActionErrors([
                    { detail: 'rpc error: code = NotFound desc = connection not found' },
                ]);

                await expect(runAndReadData()).resolves.toEqual({
                    type: 'string',
                    value: 'rpc error: code = NotFound desc = connection not found',
                });
            });

            test("Should join several of the platform's errors, using a title when there's no detail", async () => {
                mockActionErrors([{ detail: 'first' }, { title: 'second' }]);

                await expect(runAndReadData()).resolves.toEqual({
                    type: 'string',
                    value: 'first; second',
                });
            });

            test('Should reject with a fallback message when no platform error has a detail or a title', async () => {
                mockActionErrors([{}, { detail: '' }]);

                await expect(runAndReadData()).resolves.toEqual({
                    type: 'string',
                    value: 'Query execution failed',
                });
                expect(mockLogFn).toHaveBeenCalledWith(
                    '$.Actions call to "com.datadoghq.slack.chat.postMessage" failed: Query execution failed',
                    'error',
                );
            });
        });

        describe('What an uncaught failure reports, as in a deployed app', () => {
            const runAndReadError = async (failure: unknown) => {
                const failingMiddleware = createTestMiddleware({
                    executeLocally: jest.fn().mockRejectedValue(failure),
                });
                const req = createMockRequest('/__dd/executeAction', {
                    functionName: encodeQueryName(mockFunctions[0]),
                    args: [],
                });
                const res = createMockResponse();
                failingMiddleware(req, res, jest.fn());
                await res.done;
                return { statusCode: res.statusCode, error: JSON.parse(res.getBody()).error };
            };

            test('Should prefix what the function threw with "Execution failed: "', async () => {
                const thrown = new FunctionThrewError('plain error x', 'TypeError: plain error x');

                await expect(runAndReadError(thrown)).resolves.toEqual({
                    statusCode: 500,
                    error: 'Execution failed: TypeError: plain error x',
                });
            });

            test("Should leave the dev server's own failures unprefixed", async () => {
                await expect(
                    runAndReadError(new Error('"getGreeting" is not a function')),
                ).resolves.toEqual({
                    statusCode: 500,
                    error: '"getGreeting" is not a function',
                });
            });
        });

        // getAllowedConnectionIds only resolves and transforms modules, so a module the static
        // checks reject fails before any of the entry's code runs.
        test("Should never start a call's process when getAllowedConnectionIds rejects", async () => {
            const rejectingMiddleware = createTestMiddleware({
                getAllowedConnectionIds: async () => {
                    throw new Error(`"Deno" is not available in the ${NODE_BACKEND_RUNTIME}`);
                },
                executeLocally: createTestExecutor(),
            });

            const req = createMockRequest('/__dd/executeAction', {
                functionName: encodeQueryName(mockFunctions[0]),
                args: [],
            });
            const res = createMockResponse();

            rejectingMiddleware(req, res, jest.fn());
            await res.done;

            expect(res.statusCode).toBe(500);
            expect(JSON.parse(res.getBody()).error).toContain(
                `"Deno" is not available in the ${NODE_BACKEND_RUNTIME}`,
            );
            expect(forkMock).not.toHaveBeenCalled();
        });

        // getAllowedConnectionIds reads and transforms every reachable module from disk
        // (dev-server-module-graph.ts) with no bound of its own.
        test('Should eventually time out and return a clear error when getAllowedConnectionIds never settles', async () => {
            jest.useFakeTimers();
            try {
                const immediateRuntimeContextRequest = makeImmediateRuntimeContextRequest();
                const hangingMiddleware = createTestMiddleware({
                    // Never settles.
                    getAllowedConnectionIds: () => new Promise(() => {}),
                    doAuthenticatedRequest: immediateRuntimeContextRequest,
                    executeLocally: createTestExecutor(),
                });

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
            const middleware = createTestMiddleware({
                getBackendFunctions: () => currentFunctions,
            });

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
            const oldReq = createMockRequest(DEBUG_BUNDLE_PATH, {
                functionName: encodeQueryName({ relativePath: 'backend/greet', name: 'greet' }),
            });
            const oldRes = createMockResponse();

            middleware(oldReq, oldRes, jest.fn());
            await oldRes.done;

            expect(oldRes.statusCode).toBe(404);

            // New name should resolve.
            mockBuildWithParsedBackend('// greetV2 code');

            const newReq = createMockRequest(DEBUG_BUNDLE_PATH, {
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
