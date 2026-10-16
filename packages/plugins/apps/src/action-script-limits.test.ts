// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import {
    DATATRANSFORMATION_MANIFEST_PATH,
    MAX_SCRIPT_LIMIT_READS,
    SCRIPT_INPUTS_DEF_NAME,
    SCRIPT_LIMIT_COOL_DOWN_MS,
    SCRIPT_LIMIT_WARNING,
    scriptLimitRetryDelayMs,
    resetScriptLimitCache,
    resolveScriptMaxLength,
    SCRIPT_LIMIT_CACHE_KEY,
    SCRIPT_LIMIT_TIMEOUT_MS,
} from '@dd/apps-plugin/action-script-limits';
import * as authModule from '@dd/apps-plugin/auth';
import {
    FAILED_LOOKUP_RETRY_MS,
    MAX_LOGGED_REASON_LENGTH,
    getCacheKey,
} from '@dd/apps-plugin/backend-runtime';
import type { Logger } from '@dd/core/types';
import { clearDatadogEnv } from '@dd/tests/_jest/helpers/datadogEnv';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import nock from 'nock';

const SITE = 'datad0g.com';
const API_ORIGIN = `https://api.${SITE}`;
const API_KEY = 'test-api-key';
const APP_KEY = 'test-app-key';
const ACCESS_TOKEN = 'test-oauth-token';
const LIMIT = 1_048_576;
const API_KEYS = { apiKey: API_KEY, appKey: APP_KEY };

const scriptInputs = (maxLength: unknown) => ({
    type: 'object',
    properties: { script: { type: 'string', maxLength } },
});

const manifestWith = (defs: Record<string, unknown>) => ({
    data: { id: 'com.datadoghq.datatransformation', attributes: { types: { $defs: defs } } },
});

const FULL_MANIFEST = manifestWith({ [SCRIPT_INPUTS_DEF_NAME]: scriptInputs(LIMIT) });

describe('Apps Plugin - resolveScriptMaxLength', () => {
    let restoreEnv: () => void;
    let log: Logger;
    const credentials = API_KEYS;
    const cacheKey = getCacheKey(SITE, credentials);

    beforeEach(() => {
        log = getMockLogger();
        restoreEnv = clearDatadogEnv();
        resetScriptLimitCache();
        jest.clearAllMocks();
    });

    afterEach(() => {
        restoreEnv();
        nock.cleanAll();
        jest.restoreAllMocks();
    });

    test('should name the input schema as the manifest does', () => {
        expect(SCRIPT_INPUTS_DEF_NAME).toBe('JsFunctionWithActionsInputs');
    });

    test.each([
        {
            description: 'API-key auth',
            readWith: API_KEYS,
            headers: { 'DD-API-KEY': API_KEY, 'DD-APPLICATION-KEY': APP_KEY },
        },
        {
            description: 'the OAuth access token',
            readWith: { accessToken: ACCESS_TOKEN },
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        },
    ])('should read the script limit using $description', async ({ readWith, headers }) => {
        let interceptor = nock(API_ORIGIN);
        for (const [name, value] of Object.entries(headers)) {
            interceptor = interceptor.matchHeader(name, value);
        }
        const scope = interceptor.get(DATATRANSFORMATION_MANIFEST_PATH).reply(200, FULL_MANIFEST);

        const limit = await resolveScriptMaxLength(SITE, readWith, log);
        const isDone = scope.isDone();
        expect(limit).toBe(LIMIT);
        expect(isDone).toBe(true);
    });

    test('should wait longer before each retry, then cool down and start a new budget of reads', async () => {
        const nowSpy = jest.spyOn(Date, 'now');
        let now = 1_000_000;
        nowSpy.mockImplementation(() => now);
        let requests = 0;
        nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .times(MAX_SCRIPT_LIMIT_READS + 2)
            .reply(() => {
                requests += 1;
                return [503, ''];
            });

        for (let failedReads = 1; failedReads <= MAX_SCRIPT_LIMIT_READS; failedReads++) {
            // eslint-disable-next-line no-await-in-loop
            await resolveScriptMaxLength(SITE, credentials, log);
            expect(requests).toBe(failedReads);
            now += scriptLimitRetryDelayMs(failedReads) - 1;
            // eslint-disable-next-line no-await-in-loop
            await resolveScriptMaxLength(SITE, credentials, log);
            expect(requests).toBe(failedReads);
            now += 2;
        }
        const limit = await resolveScriptMaxLength(SITE, credentials, log);
        const readsAfterCoolDown = requests;
        now += scriptLimitRetryDelayMs(1) - 1;
        await resolveScriptMaxLength(SITE, credentials, log);
        const readsInNewBudgetWindow = requests;

        const warnings = mockLogFn.mock.calls.filter(([, level]) => level === 'warn');
        const expectedWarnings = Array.from({ length: MAX_SCRIPT_LIMIT_READS + 1 }, () => [
            SCRIPT_LIMIT_WARNING,
            'warn',
        ]);
        expect(readsAfterCoolDown).toBe(MAX_SCRIPT_LIMIT_READS + 1);
        expect(readsInNewBudgetWindow).toBe(MAX_SCRIPT_LIMIT_READS + 1);
        expect(limit).toBeUndefined();
        expect(warnings).toEqual(expectedWarnings);
    });

    test('should read the limit once a cool-down after its last failed read passes', async () => {
        const nowSpy = jest.spyOn(Date, 'now');
        let now = 1_000_000;
        nowSpy.mockImplementation(() => now);
        nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .times(MAX_SCRIPT_LIMIT_READS)
            .reply(503);
        for (let failedReads = 1; failedReads <= MAX_SCRIPT_LIMIT_READS; failedReads++) {
            // eslint-disable-next-line no-await-in-loop
            await resolveScriptMaxLength(SITE, credentials, log);
            now += scriptLimitRetryDelayMs(failedReads);
        }
        const recovered = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .once()
            .reply(200, FULL_MANIFEST);

        now -= 1;
        const inCoolDown = await resolveScriptMaxLength(SITE, credentials, log);
        const readInCoolDown = recovered.isDone();
        now += 2;
        const afterCoolDown = await resolveScriptMaxLength(SITE, credentials, log);
        const readAfterCoolDown = recovered.isDone();

        expect(inCoolDown).toBeUndefined();
        expect(readInCoolDown).toBe(false);
        expect(afterCoolDown).toBe(LIMIT);
        expect(readAfterCoolDown).toBe(true);
    });

    test('should start a new budget when a cool-down passes after a failed read, even with reads left', async () => {
        const nowSpy = jest.spyOn(Date, 'now');
        let now = 1_000_000;
        nowSpy.mockImplementation(() => now);
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).twice().reply(503);
        await resolveScriptMaxLength(SITE, credentials, log);
        now += scriptLimitRetryDelayMs(1) + SCRIPT_LIMIT_COOL_DOWN_MS;
        await resolveScriptMaxLength(SITE, credentials, log);
        const retry = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .once()
            .reply(200, FULL_MANIFEST);

        now += scriptLimitRetryDelayMs(1) + 1;
        const limit = await resolveScriptMaxLength(SITE, credentials, log);
        const retryDone = retry.isDone();

        expect(limit).toBe(LIMIT);
        expect(retryDone).toBe(true);
    });

    test('should read the limit separately for each set of credentials on a site', async () => {
        const otherCredentials = { apiKey: 'other-org-api-key', appKey: 'other-org-app-key' };
        const otherInputs = scriptInputs(LIMIT / 2);
        const otherManifest = manifestWith({ [SCRIPT_INPUTS_DEF_NAME]: otherInputs });
        const firstOrg = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .matchHeader('DD-API-KEY', API_KEY)
            .once()
            .reply(200, FULL_MANIFEST);
        const secondOrg = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .matchHeader('DD-API-KEY', 'other-org-api-key')
            .once()
            .reply(200, otherManifest);

        const firstLimit = await resolveScriptMaxLength(SITE, credentials, log);
        const secondLimit = await resolveScriptMaxLength(SITE, otherCredentials, log);
        const firstAgain = await resolveScriptMaxLength(SITE, credentials, log);
        const firstOrgDone = firstOrg.isDone();
        const secondOrgDone = secondOrg.isDone();

        expect([firstLimit, secondLimit, firstAgain]).toEqual([LIMIT, LIMIT / 2, LIMIT]);
        expect(firstOrgDone).toBe(true);
        expect(secondOrgDone).toBe(true);
    });

    test('should back off by doubling the retry window', () => {
        const firstDelay = scriptLimitRetryDelayMs(1);
        const secondDelay = scriptLimitRetryDelayMs(2);
        const lastDelay = scriptLimitRetryDelayMs(MAX_SCRIPT_LIMIT_READS);
        expect(firstDelay).toBe(FAILED_LOOKUP_RETRY_MS);
        expect(secondDelay).toBe(FAILED_LOOKUP_RETRY_MS * 2);
        expect(lastDelay).toBe(SCRIPT_LIMIT_COOL_DOWN_MS);
    });

    test('should read again after the retry window when logging the failure throws', async () => {
        const nowSpy = jest.spyOn(Date, 'now');
        const startedAt = 1_000_000;
        nowSpy.mockReturnValue(startedAt);
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).once().reply(500, {});
        const throwingLog: Logger = {
            ...log,
            warn: () => {
                throw new Error('logger');
            },
        };
        const failed = await resolveScriptMaxLength(SITE, credentials, throwingLog);
        const retry = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .once()
            .reply(200, FULL_MANIFEST);

        const firstRetryWindow = scriptLimitRetryDelayMs(1);
        nowSpy.mockReturnValue(startedAt + firstRetryWindow + 1);
        const retried = await resolveScriptMaxLength(SITE, credentials, log);
        const retryDone = retry.isDone();

        expect(failed).toBeUndefined();
        expect(retried).toBe(LIMIT);
        expect(retryDone).toBe(true);
    });

    test('should warn once per failed read, not per call', async () => {
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).reply(500, {});

        await resolveScriptMaxLength(SITE, credentials, log);
        await resolveScriptMaxLength(SITE, credentials, log);

        const warnings = mockLogFn.mock.calls.filter(([, level]) => level === 'warn');
        expect(warnings).toEqual([[SCRIPT_LIMIT_WARNING, 'warn']]);
    });

    test.each([
        { description: 'the request is unauthorized', status: 401, body: { errors: ['nope'] } },
        { description: 'the bundle is not found', status: 404, body: { errors: ['missing'] } },
        { description: 'the server errors', status: 500, body: { errors: ['boom'] } },
        { description: 'the body is not JSON', status: 200, body: 'not json' },
        { description: 'the body is JSON null', status: 200, body: 'null' },
        { description: 'the body has no $defs', status: 200, body: { data: { attributes: {} } } },
        {
            description: "only another action's schema has a script limit",
            status: 200,
            body: manifestWith({ OtherActionInputs: scriptInputs(LIMIT) }),
        },
        {
            description: 'maxLength is not a number',
            status: 200,
            body: manifestWith({
                [SCRIPT_INPUTS_DEF_NAME]: scriptInputs('1048576'),
            }),
        },
        {
            description: 'maxLength is not a positive integer',
            status: 200,
            body: manifestWith({
                [SCRIPT_INPUTS_DEF_NAME]: scriptInputs(-1),
            }),
        },
        {
            description: 'the input schema has no script property',
            status: 200,
            body: manifestWith({
                [SCRIPT_INPUTS_DEF_NAME]: { type: 'object', properties: {} },
            }),
        },
    ])('should resolve no limit when $description', async ({ status, body }) => {
        const scope = nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).reply(status, body);

        const limit = await resolveScriptMaxLength(SITE, credentials, log);
        const isDone = scope.isDone();
        expect(limit).toBeUndefined();
        expect(isDone).toBe(true);
    });

    test('should resolve no limit when the network request fails', async () => {
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).replyWithError('socket hang up');

        const limit = await resolveScriptMaxLength(SITE, credentials, log);
        expect(limit).toBeUndefined();
        expect(mockLogFn).toHaveBeenCalledWith(SCRIPT_LIMIT_WARNING, 'warn');
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('socket hang up'), 'debug');
    });

    test('should resolve no limit when the request fails with a value String() cannot convert', async () => {
        const unprintable: unknown = Object.create(null);
        jest.spyOn(authModule, 'createAuthenticatedRequest').mockReturnValue(async () => {
            throw unprintable;
        });

        const limit = await resolveScriptMaxLength(SITE, credentials, log);
        expect(limit).toBeUndefined();
        expect(mockLogFn).toHaveBeenCalledWith(SCRIPT_LIMIT_WARNING, 'warn');
    });

    test('should resolve no limit when the request outlives its timeout', async () => {
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);
        const timeoutSpy = jest
            .spyOn(AbortSignal, 'timeout')
            .mockImplementation(() => realTimeout(10));
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).delay(100).reply(200, FULL_MANIFEST);

        const limit = await resolveScriptMaxLength(SITE, credentials, log);
        expect(limit).toBeUndefined();
        expect(timeoutSpy).toHaveBeenCalledWith(SCRIPT_LIMIT_TIMEOUT_MS);
    });

    test('should not retry a failed request', async () => {
        const scope = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .reply(503)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .reply(200, FULL_MANIFEST);

        const limit = await resolveScriptMaxLength(SITE, credentials, log);
        const pendingMocks = scope.pendingMocks();
        expect(limit).toBeUndefined();
        expect(pendingMocks).toHaveLength(1);
    });

    test('should make a single request for concurrent and later calls', async () => {
        const scope = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .once()
            .reply(200, FULL_MANIFEST);

        const first = resolveScriptMaxLength(SITE, credentials, log);
        const concurrent = resolveScriptMaxLength(SITE, credentials, log);
        const concurrentLimits = await Promise.all([first, concurrent]);
        const laterLimit = await resolveScriptMaxLength(SITE, credentials, log);
        const isDone = scope.isDone();

        expect(concurrentLimits).toEqual([LIMIT, LIMIT]);
        expect(laterLimit).toBe(LIMIT);
        expect(isDone).toBe(true);
    });

    test.each([
        { description: 'a failed lookup', status: 500, body: {} },
        { description: 'a lookup that read no limit', status: 200, body: { data: {} } },
    ])('should retry $description once the retry window passes', async ({ status, body }) => {
        const nowSpy = jest.spyOn(Date, 'now');
        const startedAt = 1_000_000;
        nowSpy.mockReturnValue(startedAt);
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).once().reply(status, body);
        const failedLimit = await resolveScriptMaxLength(SITE, credentials, log);

        const firstRetryWindow = scriptLimitRetryDelayMs(1);
        nowSpy.mockReturnValue(startedAt + firstRetryWindow - 1);
        const cachedLimit = await resolveScriptMaxLength(SITE, credentials, log);

        const retry = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .once()
            .reply(200, FULL_MANIFEST);
        nowSpy.mockReturnValue(startedAt + firstRetryWindow + 1);
        const retriedLimit = await resolveScriptMaxLength(SITE, credentials, log);
        const retryDone = retry.isDone();

        expect(failedLimit).toBeUndefined();
        expect(cachedLimit).toBeUndefined();
        expect(retriedLimit).toBe(LIMIT);
        expect(retryDone).toBe(true);
    });

    test('should keep a successful lookup past the retry window', async () => {
        const nowSpy = jest.spyOn(Date, 'now');
        const startedAt = 1_000_000;
        nowSpy.mockReturnValue(startedAt);
        const scope = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .once()
            .reply(200, FULL_MANIFEST);
        const firstLimit = await resolveScriptMaxLength(SITE, credentials, log);

        nowSpy.mockReturnValue(startedAt + SCRIPT_LIMIT_COOL_DOWN_MS * 10);
        const laterLimit = await resolveScriptMaxLength(SITE, credentials, log);
        const isDone = scope.isDone();

        expect(firstLimit).toBe(LIMIT);
        expect(laterLimit).toBe(LIMIT);
        expect(isDone).toBe(true);
    });

    test.each([
        { description: 'a non-numeric', failedReads: 'many' },
        { description: 'a negative', failedReads: -20 },
        { description: 'a fractional', failedReads: 0.5 },
    ])(
        'should wait out the first retry window after a foreign entry with $description failure count',
        async ({ failedReads }) => {
            const nowSpy = jest.spyOn(Date, 'now');
            const startedAt = 1_000_000;
            nowSpy.mockReturnValue(startedAt);
            const foreignEntry = {
                limit: Promise.resolve(undefined),
                expiresAt: startedAt - 1,
                failedReads,
            };
            const foreignCache = new Map([[cacheKey, foreignEntry]]);
            Reflect.set(globalThis, SCRIPT_LIMIT_CACHE_KEY, foreignCache);
            const scope = nock(API_ORIGIN)
                .get(DATATRANSFORMATION_MANIFEST_PATH)
                .twice()
                .reply(500, {});

            await resolveScriptMaxLength(SITE, credentials, log);
            const firstRetryWindow = scriptLimitRetryDelayMs(1);
            nowSpy.mockReturnValue(startedAt + firstRetryWindow - 1);
            await resolveScriptMaxLength(SITE, credentials, log);

            const pendingMocks = scope.pendingMocks();
            expect(pendingMocks).toHaveLength(1);
        },
    );

    test.each([
        {
            description: 'a rejected limit',
            limit: () => {
                const rejected = Promise.reject(new Error('foreign'));
                rejected.catch(() => {});
                return rejected;
            },
        },
        { description: 'a limit that is not a number', limit: async () => 'lots' },
    ])('should resolve no limit for a foreign entry holding $description', async ({ limit }) => {
        const foreignLimit = limit();
        const foreignCache = new Map([[cacheKey, { limit: foreignLimit, expiresAt: Infinity }]]);
        Reflect.set(globalThis, SCRIPT_LIMIT_CACHE_KEY, foreignCache);

        const resolved = await resolveScriptMaxLength(SITE, credentials, log);
        expect(resolved).toBeUndefined();
    });

    test('should look the limit up again when the cached entry has an unexpected shape', async () => {
        const foreignCache = new Map([[cacheKey, { limit: LIMIT, expiresAt: Infinity }]]);
        Reflect.set(globalThis, SCRIPT_LIMIT_CACHE_KEY, foreignCache);
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).reply(200, FULL_MANIFEST);

        const limit = await resolveScriptMaxLength(SITE, credentials, log);
        expect(limit).toBe(LIMIT);
    });

    test('should cap a non-JSON error body in the log', async () => {
        const filler = 'x'.repeat(MAX_LOGGED_REASON_LENGTH);
        nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .reply(502, `<!DOCTYPE html>\n${filler}`);

        await resolveScriptMaxLength(SITE, credentials, log);

        const logged = mockLogFn.mock.calls.map(([text]) => String(text)).join('\n');
        expect(logged).toContain('<!DOCTYPE html>');
        expect(logged).not.toContain(filler);
        expect(logged).not.toContain('HTTP 502');
    });

    test('should never log the credentials', async () => {
        nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .reply(401, { errors: ['Unauthorized'] });

        await resolveScriptMaxLength(SITE, credentials, log);

        const logged = mockLogFn.mock.calls.map(([text]) => String(text)).join('\n');
        expect(mockLogFn).toHaveBeenCalled();
        expect(logged).not.toContain(API_KEY);
        expect(logged).not.toContain(APP_KEY);
    });
});
