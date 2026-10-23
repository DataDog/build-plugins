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

import { DEV_CLIENT_HOOK, RUN_QUERY_RESPONSE } from '../../../protocol';
import { BackendFunctionError } from '../../types';

import { POSTMESSAGE_TIMEOUT_MS, postMessageTransport } from './post-message-transport';

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
        const action = { fqn: 'com.datadoghq.http.request', connectionIds: ['conn-1'] };
        const extendedActions = [{ ...action, extra: () => 'not cloneable' }];
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
        const action = { fqn: 'com.datadoghq.http.request', connectionIds: ['conn-1'] };
        const forgedAction = { fqn: 'com.datadoghq.forged', connectionIds: ['conn-forged'] };
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
        const timedOut = { message: expect.stringContaining('timed out') };
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
