// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis, Proxy */

import * as authModule from '@dd/apps-plugin/auth';
import {
    V1_FALLBACK_RUNTIME,
    V1_RUNTIME,
    V2_RUNTIME,
} from '@dd/apps-plugin/backend-runtime.fixtures';
import {
    ACTIVE_FEATURE_FLAGS_PATH,
    BACKEND_RUNTIME_TIMEOUT_MS,
    FAILED_LOOKUP_RETRY_MS,
    MAX_LOGGED_REASON_LENGTH,
    getCacheKey,
    resetBackendRuntimeCache,
    resolveBackendRuntime,
    RUNTIME_CACHE_KEY,
    describeRuntime,
    FAILED_LOOKUP_WARNING,
    NO_CREDENTIALS_MESSAGE,
    NO_FAILURE_DETAILS,
    TERRAPIN_CUTOVER_FLAG,
} from '@dd/apps-plugin/backend-runtime';
import type { AuthOptions, Logger } from '@dd/core/types';
import { validateOptions } from '@dd/factory/validate';
import { clearDatadogEnv } from '@dd/tests/_jest/helpers/datadogEnv';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import nock from 'nock';

const SITE = 'datad0g.com';
const API_ORIGIN = `https://api.${SITE}`;
const API_KEY = 'test-api-key';
const APP_KEY = 'test-app-key';
const ACCESS_TOKEN = 'test-oauth-token';

const loggedIn = (flags: string[]) => ({ user_status: 'logged-in', active_feature_flags: flags });
const FLAG_ON_BODY = loggedIn(['some-other-flag', TERRAPIN_CUTOVER_FLAG]);
const FLAG_OFF_BODY = loggedIn(['some-other-flag']);

// The plugin's auth as the factory resolves it from the environment and the auth option.
const pluginAuth = (options: AuthOptions = {}) =>
    validateOptions({ auth: { site: SITE, ...options } }).auth;

const useApiKeys = () => {
    process.env.DD_API_KEY = API_KEY;
    process.env.DD_APP_KEY = APP_KEY;
};

const useOAuthToken = () => {
    process.env.DD_OAUTH_ACCESS_TOKEN = ACCESS_TOKEN;
};

test("should read Action Platform's Terrapin cutover flag", () => {
    expect(TERRAPIN_CUTOVER_FLAG).toBe('ap-js-high-code-terrapin-cutover');
});

describe('Apps Plugin - resolveBackendRuntime', () => {
    let restoreEnv: () => void;
    let log: Logger;

    beforeEach(() => {
        log = getMockLogger();
        restoreEnv = clearDatadogEnv();
        resetBackendRuntimeCache();
        jest.clearAllMocks();
    });

    afterEach(() => {
        restoreEnv();
        nock.cleanAll();
        jest.restoreAllMocks();
    });

    test.each([
        {
            description: 'API-key auth',
            setAuth: useApiKeys,
            headers: { 'DD-API-KEY': API_KEY, 'DD-APPLICATION-KEY': APP_KEY },
        },
        {
            description: 'the OAuth access token',
            setAuth: useOAuthToken,
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        },
    ])(
        'should resolve v2 when the flag is active, using $description',
        async ({ setAuth, headers }) => {
            setAuth();
            let interceptor = nock(API_ORIGIN);
            for (const [name, value] of Object.entries(headers)) {
                interceptor = interceptor.matchHeader(name, value);
            }
            const scope = interceptor.get(ACTIVE_FEATURE_FLAGS_PATH).reply(200, FLAG_ON_BODY);

            const auth = pluginAuth();
            const { runtime } = await resolveBackendRuntime(auth, log);
            const isDone = scope.isDone();
            expect(runtime).toBe('v2');
            expect(isDone).toBe(true);
        },
    );

    const OPTION_API_KEY = 'option-api-key';
    const OPTION_APP_KEY = 'option-app-key';
    const OPTION_KEYS = { apiKey: OPTION_API_KEY, appKey: OPTION_APP_KEY };
    test.each([
        {
            description: "the auth option's keys",
            setEnv: () => {},
            options: OPTION_KEYS,
            headers: { 'DD-API-KEY': OPTION_API_KEY, 'DD-APPLICATION-KEY': OPTION_APP_KEY },
        },
        {
            description: "the env keys over the auth option's",
            setEnv: useApiKeys,
            options: OPTION_KEYS,
            headers: { 'DD-API-KEY': API_KEY, 'DD-APPLICATION-KEY': APP_KEY },
        },
        {
            description: "an env API key with the auth option's app key",
            setEnv: () => {
                process.env.DD_API_KEY = API_KEY;
            },
            options: OPTION_KEYS,
            headers: { 'DD-API-KEY': API_KEY, 'DD-APPLICATION-KEY': OPTION_APP_KEY },
        },
        {
            description: "the auth option's keys over the OAuth token",
            setEnv: useOAuthToken,
            options: OPTION_KEYS,
            headers: { 'DD-API-KEY': OPTION_API_KEY, 'DD-APPLICATION-KEY': OPTION_APP_KEY },
        },
        {
            description: 'the OAuth token when the auth option has only an API key',
            setEnv: useOAuthToken,
            options: { apiKey: OPTION_API_KEY },
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        },
    ])(
        'should look the flag up with $description, as uploads resolve them',
        async ({ setEnv, options, headers }) => {
            setEnv();
            let interceptor = nock(API_ORIGIN);
            for (const [name, value] of Object.entries(headers)) {
                interceptor = interceptor.matchHeader(name, value);
            }
            const scope = interceptor.get(ACTIVE_FEATURE_FLAGS_PATH).reply(200, FLAG_ON_BODY);

            const auth = pluginAuth(options);
            const { runtime } = await resolveBackendRuntime(auth, log);
            const isDone = scope.isDone();
            expect(runtime).toBe('v2');
            expect(isDone).toBe(true);
        },
    );

    test('should not read env API keys set after the plugin resolved its auth', async () => {
        const auth = pluginAuth();
        useApiKeys();
        const scope = nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).reply(200, FLAG_ON_BODY);

        const { runtime } = await resolveBackendRuntime(auth, log);
        const isDone = scope.isDone();
        expect(runtime).toBe('v1');
        expect(isDone).toBe(false);
    });

    test.each([
        { description: 'the flag is absent', status: 200, body: FLAG_OFF_BODY },
        {
            description: 'the user is not logged in, even if the anonymous set has the flag',
            status: 200,
            body: {
                user_status: 'not-logged-in',
                active_feature_flags: [TERRAPIN_CUTOVER_FLAG],
            },
        },
        {
            description: 'the user is not logged in and the reply has no flag list',
            status: 200,
            body: { user_status: 'not-logged-in' },
        },
        { description: 'the request is unauthorized', status: 401, body: { errors: ['nope'] } },
        { description: 'the request is rate-limited', status: 429, body: { errors: ['slow'] } },
        { description: 'the server errors', status: 500, body: { errors: ['boom'] } },
        { description: 'the body is not JSON', status: 200, body: 'not json' },
        { description: 'the body is JSON null', status: 200, body: 'null' },
        {
            description: 'the flag list is not an array',
            status: 200,
            body: {
                user_status: 'logged-in',
                active_feature_flags: TERRAPIN_CUTOVER_FLAG,
            },
        },
    ])('should resolve v1 when $description', async ({ status, body }) => {
        useApiKeys();
        const scope = nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).reply(status, body);

        const auth = pluginAuth();
        const { runtime } = await resolveBackendRuntime(auth, log);
        const isDone = scope.isDone();
        expect(runtime).toBe('v1');
        expect(isDone).toBe(true);
    });

    test('should resolve v1 without a request when no credentials are set', async () => {
        const scope = nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).reply(200, FLAG_ON_BODY);

        const auth = pluginAuth();
        const { runtime } = await resolveBackendRuntime(auth, log);
        const isDone = scope.isDone();
        expect(runtime).toBe('v1');
        expect(isDone).toBe(false);
        expect(mockLogFn).toHaveBeenCalledWith(NO_CREDENTIALS_MESSAGE, 'info');
        expect(mockLogFn).not.toHaveBeenCalledWith(expect.anything(), 'warn');
    });

    test('should resolve v1 when the network request fails', async () => {
        useApiKeys();
        nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).replyWithError('socket hang up');

        const auth = pluginAuth();
        const { runtime } = await resolveBackendRuntime(auth, log);
        expect(runtime).toBe('v1');
        expect(mockLogFn).toHaveBeenCalledWith(FAILED_LOOKUP_WARNING, 'warn');
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('socket hang up'), 'debug');
    });

    test('should resolve v1 when the request outlives its timeout', async () => {
        useApiKeys();
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);
        const timeoutSpy = jest
            .spyOn(AbortSignal, 'timeout')
            .mockImplementation(() => realTimeout(10));
        nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).delay(100).reply(200, FLAG_ON_BODY);

        const auth = pluginAuth();
        const { runtime } = await resolveBackendRuntime(auth, log);
        expect(runtime).toBe('v1');
        expect(timeoutSpy).toHaveBeenCalledWith(BACKEND_RUNTIME_TIMEOUT_MS);
    });

    test('should not retry a rate-limited request', async () => {
        useApiKeys();
        const scope = nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .reply(429)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .reply(200, FLAG_ON_BODY);

        const auth = pluginAuth();
        const { runtime } = await resolveBackendRuntime(auth, log);
        const pendingMocks = scope.pendingMocks();
        expect(runtime).toBe('v1');
        expect(pendingMocks).toHaveLength(1);
    });

    test('should make a single request for concurrent and later calls', async () => {
        useApiKeys();
        const scope = nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .once()
            .reply(200, FLAG_ON_BODY);
        const auth = pluginAuth();
        const first = resolveBackendRuntime(auth, log);
        const concurrent = resolveBackendRuntime(auth, log);
        const statuses = await Promise.all([first, concurrent]);
        const { runtime: laterRuntime } = await resolveBackendRuntime(auth, log);

        const isDone = scope.isDone();
        expect(statuses).toEqual([V2_RUNTIME, V2_RUNTIME]);
        expect(laterRuntime).toBe('v2');
        expect(isDone).toBe(true);
        const infoCalls = mockLogFn.mock.calls.filter(([, level]) => level === 'info');
        expect(infoCalls).toHaveLength(1);
    });

    test('should look the runtime up again for other credentials on the same site', async () => {
        useApiKeys();
        const firstOrg = nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .matchHeader('DD-API-KEY', API_KEY)
            .once()
            .reply(200, FLAG_ON_BODY);
        const firstOrgAuth = pluginAuth();
        const { runtime: firstOrgRuntime } = await resolveBackendRuntime(firstOrgAuth, log);

        process.env.DD_API_KEY = 'other-org-api-key';
        process.env.DD_APP_KEY = 'other-org-app-key';
        const secondOrg = nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .matchHeader('DD-API-KEY', 'other-org-api-key')
            .once()
            .reply(200, FLAG_OFF_BODY);
        const secondOrgAuth = pluginAuth();
        const { runtime: secondOrgRuntime } = await resolveBackendRuntime(secondOrgAuth, log);

        const firstOrgDone = firstOrg.isDone();
        const secondOrgDone = secondOrg.isDone();
        expect(firstOrgRuntime).toBe('v2');
        expect(secondOrgRuntime).toBe('v1');
        expect(firstOrgDone).toBe(true);
        expect(secondOrgDone).toBe(true);
    });

    test('should reuse the lookup when only an unused OAuth token changes', async () => {
        useApiKeys();
        const scope = nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .once()
            .reply(200, FLAG_ON_BODY);
        const auth = pluginAuth();
        const { runtime: apiKeyRuntime } = await resolveBackendRuntime(auth, log);

        useOAuthToken();
        const { runtime: runtimeWithToken } = await resolveBackendRuntime(auth, log);

        const isDone = scope.isDone();
        expect(apiKeyRuntime).toBe('v2');
        expect(runtimeWithToken).toBe('v2');
        expect(isDone).toBe(true);
    });

    test('should retry a failed lookup once the retry window passes', async () => {
        useApiKeys();
        const nowSpy = jest.spyOn(Date, 'now');
        const startedAt = 1_000_000;
        nowSpy.mockReturnValue(startedAt);
        nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).once().reply(500, {});
        const auth = pluginAuth();
        const { runtime: failedRuntime } = await resolveBackendRuntime(auth, log);
        expect(failedRuntime).toBe('v1');

        const retry = nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .once()
            .reply(200, FLAG_ON_BODY);
        nowSpy.mockReturnValue(startedAt + FAILED_LOOKUP_RETRY_MS - 1);
        const cachedStatus = await resolveBackendRuntime(auth, log);
        const retryDoneInWindow = retry.isDone();
        expect(cachedStatus).toEqual(V1_FALLBACK_RUNTIME);
        expect(retryDoneInWindow).toBe(false);

        nowSpy.mockReturnValue(startedAt + FAILED_LOOKUP_RETRY_MS + 1);
        const { runtime: retriedRuntime } = await resolveBackendRuntime(auth, log);
        const retryDone = retry.isDone();
        expect(retriedRuntime).toBe('v2');
        expect(retryDone).toBe(true);
    });

    test('should look the runtime up again when the cached entry has an unexpected shape', async () => {
        const cacheKey = getCacheKey(SITE, undefined);
        const foreignCache = new Map([[cacheKey, { runtime: 'v2', expiresAt: Infinity }]]);
        Reflect.set(globalThis, RUNTIME_CACHE_KEY, foreignCache);

        const auth = pluginAuth();
        const { runtime } = await resolveBackendRuntime(auth, log);
        expect(runtime).toBe('v1');
    });

    const getWarnings = () =>
        mockLogFn.mock.calls.filter(([, level]) => level === 'warn').map(([text]) => String(text));

    // String() throws on an object without a prototype, such as one a library throws.
    const throwUnprintable = () => {
        const unprintable: unknown = Object.create(null);
        jest.spyOn(authModule, 'createAuthenticatedRequest').mockReturnValue(async () => {
            throw unprintable;
        });
    };

    test('should fall back to v1, with no unhandled rejection, when the lookup error cannot be stringified', async () => {
        useApiKeys();
        throwUnprintable();
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);
        try {
            const auth = pluginAuth();
            const status = await resolveBackendRuntime(auth, log);
            await new Promise((resolve) => setImmediate(resolve));
            const warnings = getWarnings();

            expect(status).toEqual(V1_FALLBACK_RUNTIME);
            expect(warnings).toEqual([FAILED_LOOKUP_WARNING]);
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });

    test('should still warn when the lookup error has a message that is not a string', async () => {
        useApiKeys();
        const oddError = Object.assign(new Error(), { message: { code: 1 } });
        jest.spyOn(authModule, 'createAuthenticatedRequest').mockReturnValue(async () => {
            throw oddError;
        });

        const auth = pluginAuth();
        const status = await resolveBackendRuntime(auth, log);
        const warnings = getWarnings();

        expect(status).toEqual(V1_FALLBACK_RUNTIME);
        expect(warnings).toEqual([FAILED_LOOKUP_WARNING]);
    });

    test.each([
        {
            description: 'a cache whose type check throws',
            cache: () =>
                new Proxy(
                    {},
                    {
                        getPrototypeOf: () => {
                            throw new Error('hostile');
                        },
                    },
                ),
        },
        {
            description: 'a cached entry holding a rejected promise',
            cache: () => {
                const rejected = Promise.reject(new Error('foreign'));
                rejected.catch(() => {});
                const cacheKey = getCacheKey(SITE, undefined);
                return new Map([[cacheKey, { runtime: rejected, expiresAt: Infinity }]]);
            },
        },
    ])('should fall back to v1, without rejecting, given $description', async ({ cache }) => {
        const foreignCache = cache();
        Reflect.set(globalThis, RUNTIME_CACHE_KEY, foreignCache);
        try {
            const auth = pluginAuth();
            const status = await resolveBackendRuntime(auth, log);
            const warnings = getWarnings();

            expect(status).toEqual(V1_FALLBACK_RUNTIME);
            expect(warnings).toEqual([FAILED_LOOKUP_WARNING]);
        } finally {
            Reflect.deleteProperty(globalThis, RUNTIME_CACHE_KEY);
        }
    });

    test.each([
        {
            description: 'a rejected',
            runtime: () => {
                const rejected = Promise.reject(new Error('foreign'));
                rejected.catch(() => {});
                return rejected;
            },
        },
        { description: 'an unrecognized', runtime: async () => 'v3' },
    ])(
        "should retry another plugin copy's $description entry once the retry window passes",
        async ({ runtime }) => {
            useApiKeys();
            const nowSpy = jest.spyOn(Date, 'now');
            const startedAt = 1_000_000;
            nowSpy.mockReturnValue(startedAt);
            const cacheKey = getCacheKey(SITE, { apiKey: API_KEY, appKey: APP_KEY });
            const foreignRuntime = runtime();
            const foreignEntry = { runtime: foreignRuntime, expiresAt: Infinity };
            const foreignCache = new Map([[cacheKey, foreignEntry]]);
            Reflect.set(globalThis, RUNTIME_CACHE_KEY, foreignCache);
            const scope = nock(API_ORIGIN)
                .get(ACTIVE_FEATURE_FLAGS_PATH)
                .once()
                .reply(200, FLAG_ON_BODY);
            try {
                const auth = pluginAuth();
                const first = resolveBackendRuntime(auth, log);
                const second = resolveBackendRuntime(auth, log);
                const concurrent = await Promise.all([first, second]);
                nowSpy.mockReturnValue(startedAt + FAILED_LOOKUP_RETRY_MS - 1);
                const cached = await resolveBackendRuntime(auth, log);
                const requestedEarly = scope.isDone();
                nowSpy.mockReturnValue(startedAt + FAILED_LOOKUP_RETRY_MS + 1);
                const retried = await resolveBackendRuntime(auth, log);
                const isDone = scope.isDone();
                const warnings = getWarnings();

                expect(concurrent).toEqual([V1_FALLBACK_RUNTIME, V1_FALLBACK_RUNTIME]);
                expect(cached).toEqual(V1_FALLBACK_RUNTIME);
                expect(requestedEarly).toBe(false);
                expect(retried).toEqual(V2_RUNTIME);
                expect(isDone).toBe(true);
                expect(warnings).toEqual([FAILED_LOOKUP_WARNING]);
            } finally {
                Reflect.deleteProperty(globalThis, RUNTIME_CACHE_KEY);
            }
        },
    );

    test('should warn once for a failed lookup that concurrent and later calls share', async () => {
        useApiKeys();
        nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .once()
            .reply(500, { errors: ['boom'] });
        const auth = pluginAuth();

        const first = resolveBackendRuntime(auth, log);
        const second = resolveBackendRuntime(auth, log);
        const concurrent = await Promise.all([first, second]);
        const later = await resolveBackendRuntime(auth, log);
        const warnings = getWarnings();
        const debugLines = mockLogFn.mock.calls.filter(([, level]) => level === 'debug');

        expect(concurrent).toEqual([V1_FALLBACK_RUNTIME, V1_FALLBACK_RUNTIME]);
        expect(later).toEqual(V1_FALLBACK_RUNTIME);
        expect(warnings).toEqual([FAILED_LOOKUP_WARNING]);
        expect(debugLines).toHaveLength(1);
    });

    test('should fall back to v1, and not cache a rejection, when logging the failure throws', async () => {
        useApiKeys();
        const nowSpy = jest.spyOn(Date, 'now');
        const startedAt = 1_000_000;
        nowSpy.mockReturnValue(startedAt);
        nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).once().reply(500, {});
        const throwingLog: Logger = {
            ...log,
            warn: () => {
                throw new Error('logger');
            },
        };
        const auth = pluginAuth();
        const status = await resolveBackendRuntime(auth, throwingLog);

        const retry = nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .once()
            .reply(200, FLAG_ON_BODY);
        nowSpy.mockReturnValue(startedAt + FAILED_LOOKUP_RETRY_MS + 1);
        const { runtime } = await resolveBackendRuntime(auth, log);
        const retryDone = retry.isDone();

        expect(status).toEqual(V1_FALLBACK_RUNTIME);
        expect({ runtime, retryDone }).toEqual({ runtime: 'v2', retryDone: true });
    });

    test('should look the runtime up again after the retry window when the error could not be stringified', async () => {
        useApiKeys();
        const nowSpy = jest.spyOn(Date, 'now');
        const startedAt = 1_000_000;
        nowSpy.mockReturnValue(startedAt);
        throwUnprintable();
        const auth = pluginAuth();
        await resolveBackendRuntime(auth, log);
        jest.mocked(authModule.createAuthenticatedRequest).mockRestore();

        const retry = nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .once()
            .reply(200, FLAG_ON_BODY);
        nowSpy.mockReturnValue(startedAt + FAILED_LOOKUP_RETRY_MS + 1);
        const { runtime } = await resolveBackendRuntime(auth, log);
        const retryDone = retry.isDone();

        expect(runtime).toBe('v2');
        expect(retryDone).toBe(true);
    });

    const getDebugLines = () =>
        mockLogFn.mock.calls.filter(([, level]) => level === 'debug').map(([text]) => String(text));

    test("should log the error's JSON details at debug level, without the HTTP status", async () => {
        useApiKeys();
        const detail = 'Forbidden: application key is missing a required scope';
        nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .reply(403, { errors: [detail] });

        const auth = pluginAuth();
        await resolveBackendRuntime(auth, log);

        const debugLines = getDebugLines();
        const warnings = getWarnings();
        expect(warnings).toEqual([FAILED_LOOKUP_WARNING]);
        expect(debugLines).toEqual([expect.stringContaining(detail)]);
        expect(debugLines[0]).not.toContain('403');
    });

    test('should say no details came back when the error carries only its HTTP status', async () => {
        useApiKeys();
        nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).reply(429, '');

        const auth = pluginAuth();
        await resolveBackendRuntime(auth, log);

        const debugLines = getDebugLines();
        expect(debugLines).toEqual([`Backend runtime lookup failed: ${NO_FAILURE_DETAILS}`]);
    });

    test('should cap a non-JSON error body in the debug line', async () => {
        useApiKeys();
        const filler = 'x'.repeat(MAX_LOGGED_REASON_LENGTH);
        nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).reply(403, `<!DOCTYPE html>\n${filler}`);

        const auth = pluginAuth();
        await resolveBackendRuntime(auth, log);

        const debugLines = getDebugLines();
        expect(debugLines).toEqual([expect.stringContaining('<!DOCTYPE html>')]);
        expect(debugLines[0]).not.toContain(filler);
    });

    test('should keep a successful lookup past the retry window', async () => {
        useApiKeys();
        const nowSpy = jest.spyOn(Date, 'now');
        const startedAt = 1_000_000;
        nowSpy.mockReturnValue(startedAt);
        const scope = nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .once()
            .reply(200, FLAG_ON_BODY);
        const auth = pluginAuth();
        const { runtime: firstRuntime } = await resolveBackendRuntime(auth, log);

        nowSpy.mockReturnValue(startedAt + FAILED_LOOKUP_RETRY_MS * 10);
        const { runtime: laterRuntime } = await resolveBackendRuntime(auth, log);
        const isDone = scope.isDone();
        expect(firstRuntime).toBe('v2');
        expect(laterRuntime).toBe('v2');
        expect(isDone).toBe(true);
    });

    test.each([
        {
            description: "the org's v2",
            status: 200,
            body: FLAG_ON_BODY,
            expected: `Following the org's ${describeRuntime('v2')}.`,
        },
        {
            description: "the org's v1",
            status: 200,
            body: FLAG_OFF_BODY,
            expected: `Following the org's ${describeRuntime('v1')}.`,
        },
    ])('should log one info line naming $description', async ({ status, body, expected }) => {
        useApiKeys();
        nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).reply(status, body);

        const auth = pluginAuth();
        await resolveBackendRuntime(auth, log);

        const infoMessages = mockLogFn.mock.calls
            .filter(([, level]) => level === 'info')
            .map(([text]) => text);
        expect(infoMessages).toEqual([expected]);
    });

    test("should keep internal names out of a failed lookup's messages", async () => {
        useApiKeys();
        nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).reply(500, {});

        const auth = pluginAuth();
        await resolveBackendRuntime(auth, log);

        const logged = mockLogFn.mock.calls.map(([text]) => String(text)).join('\n');
        const warnings = getWarnings();
        expect(warnings).toEqual([FAILED_LOOKUP_WARNING]);
        expect(logged).not.toContain(TERRAPIN_CUTOVER_FLAG);
        expect(logged).not.toContain(ACTIVE_FEATURE_FLAGS_PATH);
        expect(logged).not.toMatch(/Terrapin|HTTP 500/);
    });

    test.each([
        { description: 'API keys', setAuth: useApiKeys, secrets: [API_KEY, APP_KEY] },
        { description: 'an OAuth token', setAuth: useOAuthToken, secrets: [ACCESS_TOKEN] },
    ])('should never log $description', async ({ setAuth, secrets }) => {
        setAuth();
        nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .reply(401, { errors: ['Unauthorized'] });

        const auth = pluginAuth();
        await resolveBackendRuntime(auth, log);

        const logged = mockLogFn.mock.calls.map(([text]) => String(text)).join('\n');
        expect(mockLogFn).toHaveBeenCalled();
        for (const secret of secrets) {
            expect(logged).not.toContain(secret);
        }
    });
});

describe('Apps Plugin - resolveBackendRuntime fallback status', () => {
    let restoreEnv: () => void;
    let log: Logger;

    beforeEach(() => {
        log = getMockLogger();
        restoreEnv = clearDatadogEnv();
        resetBackendRuntimeCache();
    });

    afterEach(() => {
        restoreEnv();
        nock.cleanAll();
    });

    test.each([
        {
            description: 'the flag is active',
            setAuth: useApiKeys,
            reply: { status: 200, body: FLAG_ON_BODY },
            expected: V2_RUNTIME,
        },
        {
            description: 'the flag is inactive',
            setAuth: useApiKeys,
            reply: { status: 200, body: FLAG_OFF_BODY },
            expected: V1_RUNTIME,
        },
        {
            description: 'the lookup fails',
            setAuth: useApiKeys,
            reply: { status: 500, body: { errors: ['boom'] } },
            expected: V1_FALLBACK_RUNTIME,
        },
        {
            description: 'no credentials are set',
            setAuth: () => {},
            reply: { status: 200, body: FLAG_ON_BODY },
            expected: V1_RUNTIME,
        },
    ])('should report whether v1 is only the fallback when $description', async (testCase) => {
        testCase.setAuth();
        nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .reply(testCase.reply.status, testCase.reply.body);

        const auth = pluginAuth();
        const status = await resolveBackendRuntime(auth, log);

        expect(status).toEqual(testCase.expected);
    });

    test('should report the fallback even if its cache entry is replaced while the lookup is pending', async () => {
        useApiKeys();
        nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .delay(50)
            .reply(500, { errors: ['boom'] });

        const auth = pluginAuth();
        const pending = resolveBackendRuntime(auth, log);
        resetBackendRuntimeCache();
        const status = await pending;

        expect(status).toEqual(V1_FALLBACK_RUNTIME);
    });

    test('should keep reporting the fallback while the failed lookup is cached', async () => {
        useApiKeys();
        const scope = nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .reply(500, { errors: ['boom'] });

        const auth = pluginAuth();
        const first = await resolveBackendRuntime(auth, log);
        const unusedRetry = nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .once()
            .reply(200, FLAG_ON_BODY);
        const second = await resolveBackendRuntime(auth, log);

        const isDone = scope.isDone();
        const retried = unusedRetry.isDone();
        expect(isDone).toBe(true);
        expect(retried).toBe(false);
        expect(first).toEqual(V1_FALLBACK_RUNTIME);
        expect(second).toEqual(V1_FALLBACK_RUNTIME);
    });

    test('should stop reporting the fallback once a retry succeeds', async () => {
        useApiKeys();
        const nowSpy = jest.spyOn(Date, 'now');
        const startedAt = 1_000_000;
        nowSpy.mockReturnValue(startedAt);
        try {
            nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).once().reply(500, {});
            const auth = pluginAuth();
            const failed = await resolveBackendRuntime(auth, log);
            nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).once().reply(200, FLAG_OFF_BODY);
            nowSpy.mockReturnValue(startedAt + FAILED_LOOKUP_RETRY_MS + 1);
            const retried = await resolveBackendRuntime(auth, log);

            expect(failed).toEqual(V1_FALLBACK_RUNTIME);
            expect(retried).toEqual(V1_RUNTIME);
        } finally {
            nowSpy.mockRestore();
        }
    });
});
