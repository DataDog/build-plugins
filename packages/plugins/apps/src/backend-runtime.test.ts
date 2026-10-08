// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import {
    ACTIVE_FEATURE_FLAGS_PATH,
    BACKEND_RUNTIME_TIMEOUT_MS,
    FAILED_LOOKUP_RETRY_MS,
    MAX_LOGGED_REASON_LENGTH,
    getCacheKey,
    resetBackendRuntimeCache,
    resolveBackendRuntime,
    RUNTIME_ACTION_NAMES,
    RUNTIME_CACHE_KEY,
    TERRAPIN_BACKEND_FUNCTIONS_FLAG,
} from '@dd/apps-plugin/backend-runtime';
import type { Logger } from '@dd/core/types';
import { cleanEnv } from '@dd/tests/_jest/helpers/cleanEnv';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import nock from 'nock';

const SITE = 'datad0g.com';
const API_ORIGIN = `https://api.${SITE}`;
const API_KEY = 'test-api-key';
const APP_KEY = 'test-app-key';
const ACCESS_TOKEN = 'test-oauth-token';

const loggedIn = (flags: string[]) => ({ user_status: 'logged-in', active_feature_flags: flags });
const FLAG_ON_BODY = loggedIn(['some-other-flag', TERRAPIN_BACKEND_FUNCTIONS_FLAG]);
const FLAG_OFF_BODY = loggedIn(['some-other-flag']);

const useApiKeys = () => {
    process.env.DD_API_KEY = API_KEY;
    process.env.DD_APP_KEY = APP_KEY;
};

const useOAuthToken = () => {
    process.env.DD_OAUTH_ACCESS_TOKEN = ACCESS_TOKEN;
};

describe('Apps Plugin - resolveBackendRuntime', () => {
    let restoreEnv: () => void;
    let log: Logger;

    beforeEach(() => {
        log = getMockLogger();
        restoreEnv = cleanEnv();
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

            const runtime = await resolveBackendRuntime(SITE, log);
            const isDone = scope.isDone();
            expect(runtime).toBe('v2');
            expect(isDone).toBe(true);
        },
    );

    test.each([
        { description: 'the flag is absent', status: 200, body: FLAG_OFF_BODY },
        {
            description: 'the user is not logged in, even if the anonymous set has the flag',
            status: 200,
            body: {
                user_status: 'not-logged-in',
                active_feature_flags: [TERRAPIN_BACKEND_FUNCTIONS_FLAG],
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
                active_feature_flags: TERRAPIN_BACKEND_FUNCTIONS_FLAG,
            },
        },
    ])('should resolve v1 when $description', async ({ status, body }) => {
        useApiKeys();
        const scope = nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).reply(status, body);

        const runtime = await resolveBackendRuntime(SITE, log);
        const isDone = scope.isDone();
        expect(runtime).toBe('v1');
        expect(isDone).toBe(true);
    });

    test('should resolve v1 without a request when no credentials are set', async () => {
        const scope = nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).reply(200, FLAG_ON_BODY);

        const runtime = await resolveBackendRuntime(SITE, log);
        const isDone = scope.isDone();
        expect(runtime).toBe('v1');
        expect(isDone).toBe(false);
        expect(mockLogFn).toHaveBeenCalledWith(
            expect.stringContaining('No Datadog credentials'),
            'debug',
        );
        expect(mockLogFn).not.toHaveBeenCalledWith(expect.anything(), 'warn');
    });

    test('should resolve v1 when the network request fails', async () => {
        useApiKeys();
        nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).replyWithError('socket hang up');

        const runtime = await resolveBackendRuntime(SITE, log);
        expect(runtime).toBe('v1');
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('socket hang up'), 'warn');
    });

    test('should resolve v1 when the request outlives its timeout', async () => {
        useApiKeys();
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);
        const timeoutSpy = jest
            .spyOn(AbortSignal, 'timeout')
            .mockImplementation(() => realTimeout(10));
        nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).delay(100).reply(200, FLAG_ON_BODY);

        const runtime = await resolveBackendRuntime(SITE, log);
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

        const runtime = await resolveBackendRuntime(SITE, log);
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
        const first = resolveBackendRuntime(SITE, log);
        const concurrent = resolveBackendRuntime(SITE, log);
        const runtimes = await Promise.all([first, concurrent]);
        const laterRuntime = await resolveBackendRuntime(SITE, log);

        const isDone = scope.isDone();
        expect(runtimes).toEqual(['v2', 'v2']);
        expect(laterRuntime).toBe('v2');
        expect(concurrent).toBe(first);
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
        const firstOrgRuntime = await resolveBackendRuntime(SITE, log);

        process.env.DD_API_KEY = 'other-org-api-key';
        process.env.DD_APP_KEY = 'other-org-app-key';
        const secondOrg = nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .matchHeader('DD-API-KEY', 'other-org-api-key')
            .once()
            .reply(200, FLAG_OFF_BODY);
        const secondOrgRuntime = await resolveBackendRuntime(SITE, log);

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
        const apiKeyRuntime = await resolveBackendRuntime(SITE, log);

        useOAuthToken();
        const runtimeWithToken = await resolveBackendRuntime(SITE, log);

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
        const failedRuntime = await resolveBackendRuntime(SITE, log);
        expect(failedRuntime).toBe('v1');

        nowSpy.mockReturnValue(startedAt + FAILED_LOOKUP_RETRY_MS - 1);
        const cachedRuntime = await resolveBackendRuntime(SITE, log);
        expect(cachedRuntime).toBe('v1');

        const retry = nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .once()
            .reply(200, FLAG_ON_BODY);
        nowSpy.mockReturnValue(startedAt + FAILED_LOOKUP_RETRY_MS + 1);
        const retriedRuntime = await resolveBackendRuntime(SITE, log);
        const retryDone = retry.isDone();
        expect(retriedRuntime).toBe('v2');
        expect(retryDone).toBe(true);
    });

    test('should look the runtime up again when the cached entry has an unexpected shape', async () => {
        const cacheKey = getCacheKey(SITE, undefined);
        const foreignCache = new Map([[cacheKey, { runtime: 'v2', expiresAt: Infinity }]]);
        Reflect.set(globalThis, RUNTIME_CACHE_KEY, foreignCache);

        const runtime = await resolveBackendRuntime(SITE, log);
        expect(runtime).toBe('v1');
    });

    const getWarnings = () =>
        mockLogFn.mock.calls.filter(([, level]) => level === 'warn').map(([text]) => String(text));

    test("should keep the error's JSON details in the warning", async () => {
        useApiKeys();
        const detail = 'Forbidden: application key is missing a required scope';
        nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .reply(403, { errors: [detail] });

        await resolveBackendRuntime(SITE, log);

        const warnings = getWarnings();
        expect(warnings).toEqual([expect.stringContaining('HTTP 403 Forbidden; ')]);
        expect(warnings[0]).toContain(detail);
    });

    test('should cap a non-JSON error body in the warning', async () => {
        useApiKeys();
        const filler = 'x'.repeat(MAX_LOGGED_REASON_LENGTH);
        nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).reply(403, `<!DOCTYPE html>\n${filler}`);

        await resolveBackendRuntime(SITE, log);

        const warnings = getWarnings();
        expect(warnings).toEqual([expect.stringContaining('HTTP 403 Forbidden; <!DOCTYPE html>')]);
        expect(warnings[0]).not.toContain(filler);
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
        const firstRuntime = await resolveBackendRuntime(SITE, log);

        nowSpy.mockReturnValue(startedAt + FAILED_LOOKUP_RETRY_MS * 10);
        const laterRuntime = await resolveBackendRuntime(SITE, log);
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
            expected: `Following the org's v2 backend function runtime (${RUNTIME_ACTION_NAMES.v2}).`,
        },
        {
            description: "the org's v1",
            status: 200,
            body: FLAG_OFF_BODY,
            expected: `Following the org's v1 backend function runtime (${RUNTIME_ACTION_NAMES.v1}).`,
        },
    ])('should log one info line naming $description', async ({ status, body, expected }) => {
        useApiKeys();
        nock(API_ORIGIN).get(ACTIVE_FEATURE_FLAGS_PATH).reply(status, body);

        await resolveBackendRuntime(SITE, log);

        const infoMessages = mockLogFn.mock.calls
            .filter(([, level]) => level === 'info')
            .map(([text]) => text);
        expect(infoMessages).toEqual([expected]);
    });

    test.each([
        { description: 'API keys', setAuth: useApiKeys, secrets: [API_KEY, APP_KEY] },
        { description: 'an OAuth token', setAuth: useOAuthToken, secrets: [ACCESS_TOKEN] },
    ])('should never log $description', async ({ setAuth, secrets }) => {
        setAuth();
        nock(API_ORIGIN)
            .get(ACTIVE_FEATURE_FLAGS_PATH)
            .reply(401, { errors: ['Unauthorized'] });

        await resolveBackendRuntime(SITE, log);

        const logged = mockLogFn.mock.calls.map(([text]) => String(text)).join('\n');
        expect(mockLogFn).toHaveBeenCalled();
        for (const secret of secrets) {
            expect(logged).not.toContain(secret);
        }
    });
});
