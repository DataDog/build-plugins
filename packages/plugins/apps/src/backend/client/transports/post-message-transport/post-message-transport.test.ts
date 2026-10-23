// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import {
    ARGS,
    BUNDLE,
    DATADOG_PARENT,
    MESSAGE_WITHOUT_BUNDLE,
    QUERY_NAME,
    installFakeWindow,
    mockFetchResponse,
} from '@dd/tests/_jest/helpers/fakeWindow';

import { DEV_CLIENT_HOOK, RUN_QUERY_KEEPALIVE, RUN_QUERY_RESPONSE } from '../../../protocol';
import { BackendFunctionError } from '../../types';

import {
    POSTMESSAGE_MAX_WAIT_MS,
    POSTMESSAGE_TIMEOUT_MS,
    postMessageTransport,
} from './post-message-transport';

describe('postMessageTransport', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
        mockFetchResponse({ ok: true, json: async () => BUNDLE });
    });

    afterEach(() => {
        global.fetch = originalFetch;
        Reflect.deleteProperty(globalThis, 'window');
        Reflect.deleteProperty(globalThis, DEV_CLIENT_HOOK);
        jest.useRealTimers();
    });

    test('Should post the call at once, with no ping or bundle fetch, when no dev client is installed', async () => {
        const { postMessage, reply, pings } = installFakeWindow({});

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const [message] = postMessage.mock.calls.at(-1);
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        expect(message).toEqual(MESSAGE_WITHOUT_BUNDLE);
        expect(postMessage).toHaveBeenCalledWith(message, '*');
        const sentPings = pings();
        expect(sentPings).toHaveLength(0);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test("Should post the dev client's bundle to the origin it names", async () => {
        const { postMessage, posted, reply } = installFakeWindow();
        const prepareCall = jest
            .fn()
            .mockResolvedValue({ targetOrigin: DATADOG_PARENT, bundle: BUNDLE });
        Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        expect(prepareCall).toHaveBeenCalledWith(QUERY_NAME);
        expect(message).toEqual({ ...MESSAGE_WITHOUT_BUNDLE, bundle: BUNDLE });
        expect(postMessage).toHaveBeenCalledWith(message, DATADOG_PARENT);
    });

    const inexactTargets = [
        { description: 'no target origin', preparedCall: { bundle: BUNDLE } },
        {
            description: "the '*' target origin",
            preparedCall: { targetOrigin: '*', bundle: BUNDLE },
        },
    ];

    test.each(inexactTargets)(
        'Should not post a bundle with $description',
        async ({ preparedCall }) => {
            const { postMessage, posted, reply } = installFakeWindow();
            const prepareCall = jest.fn().mockResolvedValue(preparedCall);
            Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);

            const result = postMessageTransport(QUERY_NAME, ARGS);
            const message = await posted;
            reply(message.requestId, 'ok');

            await expect(result).resolves.toBe('ok');
            expect(message).toEqual(MESSAGE_WITHOUT_BUNDLE);
            expect(postMessage).toHaveBeenCalledWith(message, '*');
        },
    );

    test("Should post only the checked fields of the dev client's bundle", async () => {
        const { posted, reply } = installFakeWindow();
        const extendedBundle = { ...BUNDLE, extra: () => 'not cloneable' };
        const prepareCall = jest
            .fn()
            .mockResolvedValue({ targetOrigin: DATADOG_PARENT, bundle: extendedBundle });
        Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        expect(message).toEqual({ ...MESSAGE_WITHOUT_BUNDLE, bundle: BUNDLE });
    });

    test("Should post only the checked fields of the dev client's action list", async () => {
        const { posted, reply } = installFakeWindow();
        const call = { connectionId: 'conn-1', inputs: { url: 'https://example.com' } };
        const action = {
            fqn: 'com.datadoghq.http.request',
            connectionIds: ['conn-1'],
            calls: [call],
        };
        const extendedCall = { ...call, extra: () => 'not cloneable' };
        const extendedActions = [
            { ...action, calls: [extendedCall], extra: () => 'not cloneable' },
        ];
        const bundle = { ...BUNDLE, actions: extendedActions };
        const prepareCall = jest.fn().mockResolvedValue({ targetOrigin: DATADOG_PARENT, bundle });
        Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        expect(message).toEqual({
            ...MESSAGE_WITHOUT_BUNDLE,
            bundle: { ...BUNDLE, actions: [action] },
        });
    });

    test("Should copy the dev client's action list without running that array's own methods", async () => {
        const { posted, reply } = installFakeWindow();
        const action = { fqn: 'com.datadoghq.http.request', connectionIds: ['conn-1'], calls: [] };
        const forgedAction = {
            fqn: 'com.datadoghq.forged',
            connectionIds: ['conn-forged'],
            calls: [],
        };
        class ForgingArray extends Array<unknown> {}
        Reflect.defineProperty(ForgingArray, Symbol.species, {
            get: () =>
                function forgedArray() {
                    return new globalThis.Proxy([forgedAction], {
                        defineProperty: () => true,
                        set: () => true,
                    });
                },
        });
        const actions = ForgingArray.from([action]);
        const bundle = { ...BUNDLE, actions };
        const prepareCall = jest.fn().mockResolvedValue({ targetOrigin: DATADOG_PARENT, bundle });
        Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        expect(message).toEqual({
            ...MESSAGE_WITHOUT_BUNDLE,
            bundle: { ...BUNDLE, actions: [action] },
        });
    });

    test("Should copy a call's inputs as own string entries, without running the calls array's own methods", async () => {
        const { posted, reply } = installFakeWindow();
        const forged = { map: () => forged, every: () => true, extra: () => 'not cloneable' };
        const calls = [{ inputs: { url: 'https://example.com' } }];
        Object.defineProperty(calls, 'constructor', {
            value: { [Symbol.species]: () => forged },
        });
        const inputs = Object.create({ inherited: 'not copied' });
        inputs.verb = 'GET';
        const actions = [
            { fqn: 'com.datadoghq.http.request', connectionIds: [], calls },
            { fqn: 'com.datadoghq.slack.chat.postMessage', connectionIds: [], calls: [{ inputs }] },
        ];
        const bundle = { ...BUNDLE, actions };
        const prepareCall = jest.fn().mockResolvedValue({ targetOrigin: DATADOG_PARENT, bundle });
        Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        const expectedActions = [
            {
                fqn: 'com.datadoghq.http.request',
                connectionIds: [],
                calls: [{ inputs: { url: 'https://example.com' } }],
            },
            {
                fqn: 'com.datadoghq.slack.chat.postMessage',
                connectionIds: [],
                calls: [{ inputs: { verb: 'GET' } }],
            },
        ];
        expect(message).toEqual({
            ...MESSAGE_WITHOUT_BUNDLE,
            bundle: { ...BUNDLE, actions: expectedActions },
        });
    });

    test("Should copy a call's connectionId only when the call sets it itself", async () => {
        const { posted, reply } = installFakeWindow();
        const call = Object.create({ connectionId: 'conn-inherited' });
        call.inputs = {};
        const actions = [{ fqn: 'com.datadoghq.http.request', connectionIds: [], calls: [call] }];
        const bundle = { ...BUNDLE, actions };
        const prepareCall = jest.fn().mockResolvedValue({ targetOrigin: DATADOG_PARENT, bundle });
        Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        const expectedActions = [
            { fqn: 'com.datadoghq.http.request', connectionIds: [], calls: [{ inputs: {} }] },
        ];
        expect(message).toEqual({
            ...MESSAGE_WITHOUT_BUNDLE,
            bundle: { ...BUNDLE, actions: expectedActions },
        });
    });

    test("Should post the bundle without its action list when reading a call's inputs throws", async () => {
        const { posted, reply } = installFakeWindow();
        const inputs = Object.defineProperty({}, 'url', {
            enumerable: true,
            get(): never {
                throw new Error('unreadable');
            },
        });
        const actions = [
            { fqn: 'com.datadoghq.http.request', connectionIds: [], calls: [{ inputs }] },
        ];
        const bundle = { ...BUNDLE, actions };
        const prepareCall = jest.fn().mockResolvedValue({ targetOrigin: DATADOG_PARENT, bundle });
        Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        expect(message).toEqual({ ...MESSAGE_WITHOUT_BUNDLE, bundle: BUNDLE });
    });

    test('Should post the bundle without its action list when reading that list throws', async () => {
        const { postMessage, posted, reply } = installFakeWindow();
        const bundle = Object.defineProperty({ ...BUNDLE }, 'actions', {
            get(): never {
                throw new Error('unreadable');
            },
        });
        const prepareCall = jest.fn().mockResolvedValue({ targetOrigin: DATADOG_PARENT, bundle });
        Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        expect(message).toEqual({ ...MESSAGE_WITHOUT_BUNDLE, bundle: BUNDLE });
        expect(postMessage).toHaveBeenCalledWith(message, DATADOG_PARENT);
    });

    test('Should post the call without a bundle when reading the hook itself throws', async () => {
        const { postMessage, posted, reply } = installFakeWindow();
        Object.defineProperty(globalThis, DEV_CLIENT_HOOK, {
            configurable: true,
            get(): never {
                throw new Error('unreadable');
            },
        });

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        expect(postMessage).toHaveBeenCalledWith(message, '*');
    });

    test('Should post the call without a bundle when reading the hook result throws', async () => {
        const { postMessage, posted, reply } = installFakeWindow();
        const throwingResult = {
            get targetOrigin(): string {
                throw new Error('unreadable');
            },
        };
        const prepareCall = jest.fn().mockResolvedValue(throwingResult);
        Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        expect(message).toEqual(MESSAGE_WITHOUT_BUNDLE);
        expect(postMessage).toHaveBeenCalledWith(message, '*');
    });

    test('Should check the connection ids it posts, not what their iterator yields', async () => {
        const { posted, reply } = installFakeWindow();
        const allowedConnectionIds = ['conn-1'];
        Object.defineProperty(allowedConnectionIds, Symbol.iterator, {
            value: function* yieldsAnObject() {
                yield { not: 'a string' };
            },
        });
        const bundle = { code: BUNDLE.code, allowedConnectionIds };
        const prepareCall = jest.fn().mockResolvedValue({ targetOrigin: DATADOG_PARENT, bundle });
        Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        expect(message).toEqual({ ...MESSAGE_WITHOUT_BUNDLE, bundle: BUNDLE });
    });

    test('Should copy the connection ids it posts without running their own array methods', async () => {
        const { posted, reply } = installFakeWindow();
        class ForgingArray extends Array<unknown> {}
        Reflect.defineProperty(ForgingArray, Symbol.species, {
            get: () =>
                function forgedArray() {
                    return new globalThis.Proxy(['conn-forged'], {
                        defineProperty: () => true,
                        set: () => true,
                    });
                },
        });
        const allowedConnectionIds = ForgingArray.from(['conn-1']);
        const bundle = { code: BUNDLE.code, allowedConnectionIds };
        const prepareCall = jest.fn().mockResolvedValue({ targetOrigin: DATADOG_PARENT, bundle });
        Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        expect(message).toEqual({ ...MESSAGE_WITHOUT_BUNDLE, bundle: BUNDLE });
    });

    const malformedPreparedCalls = [
        {
            description: 'an origin without a scheme',
            preparedCall: { targetOrigin: 'app.datadoghq.com', bundle: BUNDLE },
            expectedTarget: '*',
        },
        {
            description: 'a non-string origin',
            preparedCall: { targetOrigin: 123, bundle: BUNDLE },
            expectedTarget: '*',
        },
        {
            description: 'a bundle that is not a bundle',
            preparedCall: { targetOrigin: DATADOG_PARENT, bundle: { code: 1 } },
            expectedTarget: DATADOG_PARENT,
        },
    ];

    test.each(malformedPreparedCalls)(
        'Should post the call without a bundle when the dev client hook returns $description',
        async ({ preparedCall, expectedTarget }) => {
            const { postMessage, posted, reply } = installFakeWindow();
            const prepareCall = jest.fn().mockResolvedValue(preparedCall);
            Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);

            const result = postMessageTransport(QUERY_NAME, ARGS);
            const message = await posted;
            reply(message.requestId, 'ok');

            await expect(result).resolves.toBe('ok');
            expect(message).toEqual(MESSAGE_WITHOUT_BUNDLE);
            expect(postMessage).toHaveBeenCalledWith(message, expectedTarget);
        },
    );

    const hookError = new Error('broken');
    const failingHooks = [
        { description: 'rejects', prepareCall: jest.fn().mockRejectedValue(hookError) },
        { description: 'returns no promise', prepareCall: jest.fn().mockReturnValue(undefined) },
    ];

    test.each(failingHooks)(
        'Should still post the call without a bundle when the dev client hook $description',
        async ({ prepareCall }) => {
            const { postMessage, posted, reply } = installFakeWindow();
            Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);

            const result = postMessageTransport(QUERY_NAME, ARGS);
            const message = await posted;
            reply(message.requestId, 'ok');

            await expect(result).resolves.toBe('ok');
            expect(message).toEqual(MESSAGE_WITHOUT_BUNDLE);
            expect(postMessage).toHaveBeenCalledWith(message, '*');
        },
    );

    test('Should post the call without a bundle when the dev client hook never settles', async () => {
        jest.useFakeTimers();
        const { postMessage } = installFakeWindow();
        const pendingForever = new Promise(() => {});
        const prepareCall = jest.fn().mockReturnValue(pendingForever);
        Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);

        postMessageTransport(QUERY_NAME, ARGS).catch(() => {});
        await jest.advanceTimersByTimeAsync(POSTMESSAGE_TIMEOUT_MS);

        const [message, targetOrigin] = postMessage.mock.calls.at(-1) ?? [];
        expect(message).toEqual(MESSAGE_WITHOUT_BUNDLE);
        expect(targetOrigin).toBe('*');
    });

    test('Should resolve a success whose result has no data as undefined', async () => {
        const { posted, listeners, parent } = installFakeWindow();

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        const response = {
            type: RUN_QUERY_RESPONSE,
            requestId: message.requestId,
            success: true,
            result: {},
        };
        for (const listener of listeners()) {
            listener({ data: response, source: parent });
        }

        await expect(result).resolves.toBeUndefined();
    });

    const malformedResponses = [
        {
            description: 'a success that carries no result',
            fields: { success: true },
            expectedMessage: `Backend function "${QUERY_NAME}" failed`,
        },
        {
            description: 'a truthy success that is not true',
            fields: { success: 1 },
            expectedMessage: `Backend function "${QUERY_NAME}" failed`,
        },
        {
            description: 'an error without a success field',
            fields: { error: 'Permission denied' },
            expectedMessage: 'Permission denied',
        },
        {
            description: 'a failure whose error is not a string',
            fields: { success: false, error: { code: 403 } },
            expectedMessage: `Backend function "${QUERY_NAME}" failed`,
        },
    ];

    test.each(malformedResponses)(
        'Should reject at once on $description',
        async ({ fields, expectedMessage }) => {
            const { posted, listeners, parent } = installFakeWindow();

            const result = postMessageTransport(QUERY_NAME, ARGS);
            const outcome = result.catch((error: unknown) => error);
            const message = await posted;
            const response = { type: RUN_QUERY_RESPONSE, requestId: message.requestId, ...fields };
            for (const listener of listeners()) {
                listener({ data: response, source: parent });
            }

            const error = await outcome;
            expect(error).toBeInstanceOf(BackendFunctionError);
            expect(error).toMatchObject({ message: expectedMessage });
        },
    );

    test('Should ignore a run-query response from any window but the parent', async () => {
        const { posted, reply } = installFakeWindow();

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'forged', {});
        const stillPending = new Promise((resolve) => {
            setImmediate(resolve, 'pending');
        });
        const earlyOutcome = await Promise.race([result, stillPending]);
        expect(earlyOutcome).toBe('pending');
        reply(message.requestId, 'from-parent');

        await expect(result).resolves.toBe('from-parent');
    });

    const OTHER_ORIGIN = 'https://example.com';
    const timedOut = { message: expect.stringContaining('timed out') };

    const installTargetedCall = () => {
        const fakeWindow = installFakeWindow();
        const prepareCall = jest
            .fn()
            .mockResolvedValue({ targetOrigin: DATADOG_PARENT, bundle: BUNDLE });
        Reflect.set(globalThis, DEV_CLIENT_HOOK, prepareCall);
        return fakeWindow;
    };

    test('Should ignore a response from the parent window at another origin than it posted to', async () => {
        const { posted, reply, parent } = installTargetedCall();

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'forged', parent, OTHER_ORIGIN);
        const stillPending = new Promise((resolve) => {
            setImmediate(resolve, 'pending');
        });
        const earlyOutcome = await Promise.race([result, stillPending]);
        expect(earlyOutcome).toBe('pending');
        reply(message.requestId, 'from-parent', parent, DATADOG_PARENT);

        await expect(result).resolves.toBe('from-parent');
    });

    test('Should time out when only another origin answers a call posted to an exact origin', async () => {
        jest.useFakeTimers();
        const { posted, reply, parent, listenerCount } = installTargetedCall();

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const outcome = result.catch((error: unknown) => error);
        const message = await posted;
        reply(message.requestId, 'forged', parent, OTHER_ORIGIN);
        await jest.advanceTimersByTimeAsync(POSTMESSAGE_TIMEOUT_MS);

        const error = await outcome;
        expect(error).toBeInstanceOf(BackendFunctionError);
        expect(error).toMatchObject(timedOut);
        const remainingListeners = listenerCount();
        expect(remainingListeners).toBe(0);
    });

    test("Should accept the parent's response from any origin when it posted with '*'", async () => {
        const { postMessage, posted, reply, parent } = installFakeWindow({});

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok', parent, OTHER_ORIGIN);

        await expect(result).resolves.toBe('ok');
        expect(postMessage).toHaveBeenCalledWith(message, '*');
    });

    test('Should settle each call only with the response carrying its own request id', async () => {
        const { postMessage, reply } = installFakeWindow();

        const first = postMessageTransport(QUERY_NAME, ['first']);
        const second = postMessageTransport(QUERY_NAME, ['second']);
        const [[firstQuery], [secondQuery]] = postMessage.mock.calls;
        expect(firstQuery).toMatchObject({ args: ['first'] });
        expect(secondQuery).toMatchObject({ args: ['second'] });
        expect(firstQuery.requestId).not.toBe(secondQuery.requestId);

        reply('unknown-request-id', 'stray');
        const stillPending = new Promise((resolve) => {
            setImmediate(resolve, 'pending');
        });
        const earlyOutcomes = await Promise.all([
            Promise.race([first, stillPending]),
            Promise.race([second, stillPending]),
        ]);
        expect(earlyOutcomes).toEqual(['pending', 'pending']);
        reply(secondQuery.requestId, 'second-result');
        reply(firstQuery.requestId, 'first-result');

        await expect(first).resolves.toBe('first-result');
        await expect(second).resolves.toBe('second-result');
    });

    describe('keepalive', () => {
        type FakeWindow = ReturnType<typeof installFakeWindow>;

        const isPending = async (result: Promise<unknown>) => {
            const marker = Symbol('pending');
            const settledMarker = Promise.resolve(marker);
            const outcome = await Promise.race([result, settledMarker]);
            return outcome === marker;
        };

        beforeEach(() => {
            jest.useFakeTimers();
        });

        test("Should keep waiting past the timeout while the parent keeps the call's request alive", async () => {
            const fakeWindow = installTargetedCall();
            const result = postMessageTransport(QUERY_NAME, ARGS);
            const message = await fakeWindow.posted;

            await jest.advanceTimersByTimeAsync(POSTMESSAGE_TIMEOUT_MS - 1);
            fakeWindow.keepAlive(message.requestId);
            await jest.advanceTimersByTimeAsync(POSTMESSAGE_TIMEOUT_MS - 1);

            const stillPending = await isPending(result);
            expect(stillPending).toBe(true);
            fakeWindow.reply(message.requestId, 'ok');
            await expect(result).resolves.toBe('ok');
        });

        test('Should time out a full timeout after the last keepalive', async () => {
            const fakeWindow = installTargetedCall();
            const result = postMessageTransport(QUERY_NAME, ARGS);
            const outcome = result.catch((error: unknown) => error);
            const message = await fakeWindow.posted;

            await jest.advanceTimersByTimeAsync(1_000);
            fakeWindow.keepAlive(message.requestId);
            await jest.advanceTimersByTimeAsync(POSTMESSAGE_TIMEOUT_MS - 1);
            const stillPending = await isPending(result);
            expect(stillPending).toBe(true);
            await jest.advanceTimersByTimeAsync(1);

            const error = await outcome;
            expect(error).toBeInstanceOf(BackendFunctionError);
            expect(error).toMatchObject(timedOut);
            const remainingListeners = fakeWindow.listenerCount();
            expect(remainingListeners).toBe(0);
        });

        test("Should accept a keepalive from the parent at any origin when it posted with '*'", async () => {
            const fakeWindow = installFakeWindow({});
            const result = postMessageTransport(QUERY_NAME, ARGS);
            const message = await fakeWindow.posted;

            await jest.advanceTimersByTimeAsync(POSTMESSAGE_TIMEOUT_MS - 1);
            fakeWindow.keepAlive(message.requestId, fakeWindow.parent, OTHER_ORIGIN);
            await jest.advanceTimersByTimeAsync(POSTMESSAGE_TIMEOUT_MS - 1);

            const stillPending = await isPending(result);
            expect(stillPending).toBe(true);
            fakeWindow.reply(message.requestId, 'ok', fakeWindow.parent, OTHER_ORIGIN);
            await expect(result).resolves.toBe('ok');
        });

        const ignoredKeepAlives = [
            {
                description: 'any window but the parent',
                send: (fakeWindow: FakeWindow, requestId: string) =>
                    fakeWindow.keepAlive(requestId, {}),
            },
            {
                description: 'the parent at another origin than the call was posted to',
                send: (fakeWindow: FakeWindow, requestId: string) =>
                    fakeWindow.keepAlive(requestId, fakeWindow.parent, OTHER_ORIGIN),
            },
            {
                description: 'the parent, for another request id',
                send: (fakeWindow: FakeWindow) => fakeWindow.keepAlive('unknown-request-id'),
            },
        ];

        test.each(ignoredKeepAlives)(
            'Should ignore a keepalive from $description',
            async ({ send }) => {
                const fakeWindow = installTargetedCall();
                const result = postMessageTransport(QUERY_NAME, ARGS);
                const outcome = result.catch((error: unknown) => error);
                const message = await fakeWindow.posted;

                await jest.advanceTimersByTimeAsync(POSTMESSAGE_TIMEOUT_MS - 1);
                send(fakeWindow, message.requestId);
                await jest.advanceTimersByTimeAsync(1);

                const error = await outcome;
                expect(error).toBeInstanceOf(BackendFunctionError);
                expect(error).toMatchObject(timedOut);
            },
        );

        test('Should ignore a keepalive or reply that reaches the call after it settled', async () => {
            const fakeWindow = installTargetedCall();
            const result = postMessageTransport(QUERY_NAME, ARGS);
            const message = await fakeWindow.posted;
            const [handleMessage] = fakeWindow.listeners();
            fakeWindow.reply(message.requestId, 'ok');
            await expect(result).resolves.toBe('ok');

            // Calls the listener directly, so this holds even if it were still attached.
            const sendLate = (data: unknown) =>
                handleMessage({ data, origin: DATADOG_PARENT, source: fakeWindow.parent });
            sendLate({ type: RUN_QUERY_KEEPALIVE, requestId: message.requestId });
            const timersAfterKeepAlive = jest.getTimerCount();
            expect(timersAfterKeepAlive).toBe(0);
            sendLate({ type: RUN_QUERY_RESPONSE, requestId: message.requestId, success: false });

            await jest.advanceTimersByTimeAsync(POSTMESSAGE_MAX_WAIT_MS);
            await expect(result).resolves.toBe('ok');
            const remainingListeners = fakeWindow.listenerCount();
            expect(remainingListeners).toBe(0);
        });

        const sleeps = [
            { description: 'the timeout', sleepMs: POSTMESSAGE_TIMEOUT_MS },
            { description: 'the maximum wait', sleepMs: POSTMESSAGE_MAX_WAIT_MS },
        ];

        test.each(sleeps)(
            'Should time out on a keepalive that arrives after $description passed while timers were paused',
            async ({ sleepMs }) => {
                const fakeWindow = installTargetedCall();
                const result = postMessageTransport(QUERY_NAME, ARGS);
                const outcome = result.catch((error: unknown) => error);
                const message = await fakeWindow.posted;

                // Moves the clock without running timers, as when the machine sleeps.
                jest.setSystemTime(Date.now() + sleepMs);
                fakeWindow.keepAlive(message.requestId);

                const remainingTimers = jest.getTimerCount();
                const remainingListeners = fakeWindow.listenerCount();
                expect(remainingTimers).toBe(0);
                expect(remainingListeners).toBe(0);
                const error = await outcome;
                expect(error).toBeInstanceOf(BackendFunctionError);
                expect(error).toMatchObject(timedOut);
            },
        );

        test('Should time out at the maximum wait however often the parent keeps the call alive', async () => {
            const fakeWindow = installTargetedCall();
            const result = postMessageTransport(QUERY_NAME, ARGS);
            const outcome = result.catch((error: unknown) => error);
            const message = await fakeWindow.posted;
            const interval = POSTMESSAGE_TIMEOUT_MS - 1;

            const keepAliveCount = Math.ceil(POSTMESSAGE_MAX_WAIT_MS / interval) - 1;
            for (let count = 0; count < keepAliveCount; count++) {
                // eslint-disable-next-line no-await-in-loop
                await jest.advanceTimersByTimeAsync(interval);
                fakeWindow.keepAlive(message.requestId);
            }
            await jest.advanceTimersByTimeAsync(
                POSTMESSAGE_MAX_WAIT_MS - keepAliveCount * interval - 1,
            );
            fakeWindow.keepAlive(message.requestId);
            const stillPending = await isPending(result);
            expect(stillPending).toBe(true);
            await jest.advanceTimersByTimeAsync(1);

            const error = await outcome;
            expect(error).toBeInstanceOf(BackendFunctionError);
            expect(error).toMatchObject(timedOut);
            const remainingTimers = jest.getTimerCount();
            expect(remainingTimers).toBe(0);
        });
    });

    test('Should reject the call and stop waiting when the message cannot be posted', async () => {
        jest.useFakeTimers();
        const { postMessage, listenerCount } = installFakeWindow();
        const cloneError = new Error('could not be cloned');
        postMessage.mockImplementation(() => {
            throw cloneError;
        });

        const result = postMessageTransport(QUERY_NAME, ARGS);

        await expect(result).rejects.toBe(cloneError);
        const remainingListeners = listenerCount();
        const remainingTimers = jest.getTimerCount();
        expect(remainingListeners).toBe(0);
        expect(remainingTimers).toBe(0);
    });
});
