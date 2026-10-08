// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import {
    DATATRANSFORMATION_MANIFEST_PATH,
    getInputsDefName,
    resetScriptLimitsCache,
    resolveScriptMaxLengths,
    SCRIPT_LIMITS_CACHE_KEY,
    SCRIPT_LIMITS_TIMEOUT_MS,
} from '@dd/apps-plugin/action-script-limits';
import { getAuthenticatedRequest } from '@dd/apps-plugin/auth';
import type { DoAuthenticatedRequest } from '@dd/apps-plugin/auth';
import { FAILED_LOOKUP_RETRY_MS, MAX_LOGGED_REASON_LENGTH } from '@dd/apps-plugin/backend-runtime';
import type { BackendRuntime } from '@dd/apps-plugin/backend-runtime';
import type { Logger } from '@dd/core/types';
import { cleanEnv } from '@dd/tests/_jest/helpers/cleanEnv';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import nock from 'nock';

const SITE = 'datad0g.com';
const API_ORIGIN = `https://api.${SITE}`;
const API_KEY = 'test-api-key';
const APP_KEY = 'test-app-key';
const ACCESS_TOKEN = 'test-oauth-token';
const LIMITS: Record<BackendRuntime, number> = { v1: 1_048_576, v2: 10_240 };

const scriptInputs = (maxLength: unknown) => ({
    type: 'object',
    properties: { script: { type: 'string', maxLength } },
});

const manifestWith = (defs: Record<string, unknown>) => ({
    data: { id: 'com.datadoghq.datatransformation', attributes: { types: { $defs: defs } } },
});

const FULL_MANIFEST = manifestWith({
    [getInputsDefName('v1')]: scriptInputs(LIMITS.v1),
    [getInputsDefName('v2')]: scriptInputs(LIMITS.v2),
});

describe('Apps Plugin - resolveScriptMaxLengths', () => {
    let restoreEnv: () => void;
    let log: Logger;
    let doAuthenticatedRequest: DoAuthenticatedRequest;

    beforeEach(() => {
        log = getMockLogger();
        restoreEnv = cleanEnv();
        process.env.DD_API_KEY = API_KEY;
        process.env.DD_APP_KEY = APP_KEY;
        doAuthenticatedRequest = getAuthenticatedRequest();
        resetScriptLimitsCache();
        jest.clearAllMocks();
    });

    afterEach(() => {
        restoreEnv();
        nock.cleanAll();
        jest.restoreAllMocks();
    });

    test.each([
        { runtime: 'v1', expected: 'JsFunctionWithActionsInputs' },
        { runtime: 'v2', expected: 'JsSandboxWithActionsInputs' },
    ] satisfies Array<{ runtime: BackendRuntime; expected: string }>)(
        "should name the $runtime action's input schema as the manifest does",
        ({ runtime, expected }) => {
            const inputsDefName = getInputsDefName(runtime);
            expect(inputsDefName).toBe(expected);
        },
    );

    test.each([
        {
            description: 'API-key auth',
            setAuth: () => {},
            headers: { 'DD-API-KEY': API_KEY, 'DD-APPLICATION-KEY': APP_KEY },
        },
        {
            description: 'the OAuth access token',
            setAuth: () => {
                delete process.env.DD_API_KEY;
                delete process.env.DD_APP_KEY;
                process.env.DD_OAUTH_ACCESS_TOKEN = ACCESS_TOKEN;
            },
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        },
    ])(
        "should read both runtimes' script limits using $description",
        async ({ setAuth, headers }) => {
            setAuth();
            let interceptor = nock(API_ORIGIN);
            for (const [name, value] of Object.entries(headers)) {
                interceptor = interceptor.matchHeader(name, value);
            }
            const scope = interceptor
                .get(DATATRANSFORMATION_MANIFEST_PATH)
                .reply(200, FULL_MANIFEST);

            const request = getAuthenticatedRequest();

            const limits = await resolveScriptMaxLengths(SITE, request, log);
            const isDone = scope.isDone();
            expect(limits).toEqual(LIMITS);
            expect(isDone).toBe(true);
        },
    );

    test('should keep the limit of one runtime when the other is missing', async () => {
        const v2Inputs = scriptInputs(LIMITS.v2);
        const v2OnlyManifest = manifestWith({ [getInputsDefName('v2')]: v2Inputs });
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).reply(200, v2OnlyManifest);

        const limits = await resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);
        expect(limits).toEqual({ v2: LIMITS.v2 });
    });

    test.each([
        { description: 'the request is unauthorized', status: 401, body: { errors: ['nope'] } },
        { description: 'the bundle is not found', status: 404, body: { errors: ['missing'] } },
        { description: 'the server errors', status: 500, body: { errors: ['boom'] } },
        { description: 'the body is not JSON', status: 200, body: 'not json' },
        { description: 'the body is JSON null', status: 200, body: 'null' },
        { description: 'the body has no $defs', status: 200, body: { data: { attributes: {} } } },
        {
            description: 'maxLength is not a number',
            status: 200,
            body: manifestWith({
                [getInputsDefName('v1')]: scriptInputs('1048576'),
                [getInputsDefName('v2')]: scriptInputs(null),
            }),
        },
        {
            description: 'maxLength is not a positive integer',
            status: 200,
            body: manifestWith({
                [getInputsDefName('v1')]: scriptInputs(-1),
                [getInputsDefName('v2')]: scriptInputs(10.5),
            }),
        },
        {
            description: 'the input schema has no script property',
            status: 200,
            body: manifestWith({
                [getInputsDefName('v1')]: { type: 'object', properties: {} },
                [getInputsDefName('v2')]: 'JsSandboxWithActionsInputs',
            }),
        },
    ])('should resolve no limits when $description', async ({ status, body }) => {
        const scope = nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).reply(status, body);

        const limits = await resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);
        const isDone = scope.isDone();
        expect(limits).toEqual({});
        expect(isDone).toBe(true);
    });

    test('should resolve no limits when the network request fails', async () => {
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).replyWithError('socket hang up');

        const limits = await resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);
        expect(limits).toEqual({});
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('socket hang up'), 'debug');
    });

    test('should resolve no limits when the request outlives its timeout', async () => {
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);
        const timeoutSpy = jest
            .spyOn(AbortSignal, 'timeout')
            .mockImplementation(() => realTimeout(10));
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).delay(100).reply(200, FULL_MANIFEST);

        const limits = await resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);
        expect(limits).toEqual({});
        expect(timeoutSpy).toHaveBeenCalledWith(SCRIPT_LIMITS_TIMEOUT_MS);
    });

    test('should not retry a failed request', async () => {
        const scope = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .reply(503)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .reply(200, FULL_MANIFEST);

        const limits = await resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);
        const pendingMocks = scope.pendingMocks();
        expect(limits).toEqual({});
        expect(pendingMocks).toHaveLength(1);
    });

    test('should make a single request for concurrent and later calls', async () => {
        const scope = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .once()
            .reply(200, FULL_MANIFEST);

        const first = resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);
        const concurrent = resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);
        const concurrentLimits = await Promise.all([first, concurrent]);
        const laterLimits = await resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);
        const isDone = scope.isDone();

        expect(concurrentLimits).toEqual([LIMITS, LIMITS]);
        expect(laterLimits).toEqual(LIMITS);
        expect(concurrent).toBe(first);
        expect(isDone).toBe(true);
    });

    test.each([
        { description: 'a failed lookup', status: 500, body: {} },
        { description: 'a lookup that read no limits', status: 200, body: { data: {} } },
    ])('should retry $description once the retry window passes', async ({ status, body }) => {
        const nowSpy = jest.spyOn(Date, 'now');
        const startedAt = 1_000_000;
        nowSpy.mockReturnValue(startedAt);
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).once().reply(status, body);
        const failedLimits = await resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);

        nowSpy.mockReturnValue(startedAt + FAILED_LOOKUP_RETRY_MS - 1);
        const cachedLimits = await resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);

        const retry = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .once()
            .reply(200, FULL_MANIFEST);
        nowSpy.mockReturnValue(startedAt + FAILED_LOOKUP_RETRY_MS + 1);
        const retriedLimits = await resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);
        const retryDone = retry.isDone();

        expect(failedLimits).toEqual({});
        expect(cachedLimits).toEqual({});
        expect(retriedLimits).toEqual(LIMITS);
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
        const firstLimits = await resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);

        nowSpy.mockReturnValue(startedAt + FAILED_LOOKUP_RETRY_MS * 10);
        const laterLimits = await resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);
        const isDone = scope.isDone();

        expect(firstLimits).toEqual(LIMITS);
        expect(laterLimits).toEqual(LIMITS);
        expect(isDone).toBe(true);
    });

    test('should look the limits up again when the cached entry has an unexpected shape', async () => {
        const foreignCache = new Map([[SITE, { v2: 1 }]]);
        Reflect.set(globalThis, SCRIPT_LIMITS_CACHE_KEY, foreignCache);
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).reply(200, FULL_MANIFEST);

        const limits = await resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);
        expect(limits).toEqual(LIMITS);
    });

    test('should cap a non-JSON error body in the log', async () => {
        const filler = 'x'.repeat(MAX_LOGGED_REASON_LENGTH);
        nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .reply(502, `<!DOCTYPE html>\n${filler}`);

        await resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);

        const logged = mockLogFn.mock.calls.map(([text]) => String(text)).join('\n');
        expect(logged).toContain('HTTP 502 Bad Gateway; <!DOCTYPE html>');
        expect(logged).not.toContain(filler);
    });

    test('should never log the credentials', async () => {
        nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .reply(401, { errors: ['Unauthorized'] });

        await resolveScriptMaxLengths(SITE, doAuthenticatedRequest, log);

        const logged = mockLogFn.mock.calls.map(([text]) => String(text)).join('\n');
        expect(mockLogFn).toHaveBeenCalled();
        expect(logged).not.toContain(API_KEY);
        expect(logged).not.toContain(APP_KEY);
    });
});
