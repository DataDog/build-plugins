// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import { DEBUG_BUNDLE_PATH, DEV_SERVER_MARKER } from '../../../protocol';

import {
    BUNDLE_FETCH_TIMEOUT_MS,
    PARENT_PING_TIMEOUT_MS,
    POSTMESSAGE_TIMEOUT_MS,
    postMessageTransport,
} from './post-message-transport';

type MessageListener = (event: { data: unknown; origin?: string; source?: unknown }) => void;
type PostedMessage = { type: string; requestId: string };

const QUERY_NAME = 'backend/greet.greet';
const ARGS = ['world', 42];
const BUNDLE = { code: 'export async function main($) {}', allowedConnectionIds: ['conn-1'] };
const DATADOG_PARENT = 'https://app.datadoghq.com';

// The node-only jest harness has no DOM, so a minimal stand-in covers what the transport touches.
function installFakeWindow(
    location: { ancestorOrigins?: string[] } = { ancestorOrigins: [DATADOG_PARENT] },
) {
    const listeners = new Set<MessageListener>();
    const postMessage = jest.fn();
    const fakeWindow = {
        addEventListener: (_type: string, listener: MessageListener) => listeners.add(listener),
        removeEventListener: (_type: string, listener: MessageListener) =>
            listeners.delete(listener),
        parent: { postMessage },
        location,
    };
    Object.defineProperty(globalThis, 'window', {
        value: fakeWindow,
        configurable: true,
        writable: true,
    });

    const posted = new Promise<{ requestId: string }>((resolve) => {
        postMessage.mockImplementation((message: PostedMessage) => {
            if (message.type === 'app-builder:run-query') {
                resolve(message);
            }
        });
    });
    const pings = () =>
        postMessage.mock.calls
            .map(([message]: [PostedMessage]) => message)
            .filter((message) => message.type === 'app-builder:ping');
    const pong = (origin: string, source: unknown = fakeWindow.parent) => {
        const [ping] = pings();
        for (const listener of [...listeners]) {
            listener({
                data: { type: 'app-builder:pong', requestId: ping.requestId, availableQueries: [] },
                origin,
                source,
            });
        }
    };
    const reply = (
        requestId: string,
        data: unknown,
        source: unknown = fakeWindow.parent,
        origin = DATADOG_PARENT,
    ) => {
        for (const listener of [...listeners]) {
            listener({
                data: {
                    type: 'app-builder:run-query:response',
                    requestId,
                    success: true,
                    result: { data },
                },
                origin,
                source,
            });
        }
    };

    return { postMessage, posted, reply, pings, pong, listenerCount: () => listeners.size };
}

type FakeResponse = { ok: boolean; status?: number; json: () => Promise<unknown> };

function mockFetchResponse(response: FakeResponse) {
    global.fetch = jest.fn().mockResolvedValue(response);
}

const MESSAGE_WITHOUT_BUNDLE = {
    type: 'app-builder:run-query',
    requestId: expect.any(String),
    queryName: QUERY_NAME,
    args: ARGS,
};

describe('postMessageTransport', () => {
    let originalFetch: typeof fetch;
    let warn: jest.SpyInstance;

    beforeEach(() => {
        originalFetch = global.fetch;
        Reflect.set(globalThis, DEV_SERVER_MARKER, true);
        warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        global.fetch = originalFetch;
        Reflect.deleteProperty(globalThis, 'window');
        Reflect.deleteProperty(globalThis, DEV_SERVER_MARKER);
        warn.mockRestore();
        jest.useRealTimers();
    });

    test('Should attach its own dev server bundle to the run-query message', async () => {
        const { posted, reply } = installFakeWindow();
        mockFetchResponse({ ok: true, json: async () => BUNDLE });

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, { greeting: 'hi' });

        await expect(result).resolves.toEqual({ greeting: 'hi' });
        expect(message).toEqual({ ...MESSAGE_WITHOUT_BUNDLE, bundle: BUNDLE });
        expect(warn).not.toHaveBeenCalled();
    });

    const datadogParents = [
        'https://app.datadoghq.com',
        'https://dd.datad0g.com',
        'https://app.datadoghq.eu',
        'https://us3.datadoghq.com',
        'https://myorg.us5.datadoghq.com',
        'https://app.ddog-gov.com',
        'https://app.datadoghq.com.',
    ];

    test.each(datadogParents)('Should attach the bundle for a %s parent', async (parentOrigin) => {
        const { postMessage, posted, reply } = installFakeWindow({
            ancestorOrigins: [parentOrigin],
        });
        mockFetchResponse({ ok: true, json: async () => BUNDLE });

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');
        await result;

        expect(message).toHaveProperty('bundle', BUNDLE);
        expect(postMessage).toHaveBeenCalledWith(message, parentOrigin);
    });

    const nonDatadogParents = [
        { description: 'a plain-http Datadog host', parentOrigin: 'http://app.datadoghq.com' },
        {
            description: 'a lookalike host ending in a Datadog site',
            parentOrigin: 'https://app.datadoghq.com.evil.example',
        },
        {
            description: 'a host that only contains a site name',
            parentOrigin: 'https://evildatadoghq.com',
        },
        {
            description: 'a Datadog host on a non-default port',
            parentOrigin: 'https://app.datadoghq.com:8443',
        },
        { description: 'a local page', parentOrigin: 'http://localhost:5173' },
        { description: 'an opaque origin', parentOrigin: 'null' },
    ];

    test.each(nonDatadogParents)(
        'Should send the call without fetching a bundle for $description',
        async ({ parentOrigin }) => {
            const { postMessage, posted, reply } = installFakeWindow({
                ancestorOrigins: [parentOrigin],
            });
            mockFetchResponse({ ok: true, json: async () => BUNDLE });

            const result = postMessageTransport(QUERY_NAME, ARGS);
            const message = await posted;
            reply(message.requestId, 'ok');

            await expect(result).resolves.toBe('ok');
            expect(global.fetch).not.toHaveBeenCalled();
            expect(message).not.toHaveProperty('bundle');
            expect(postMessage).toHaveBeenCalledWith(message, '*');
            expect(warn).not.toHaveBeenCalled();
        },
    );

    // Firefox has no ancestorOrigins, so the parent's origin comes from its answer to a ping.
    describe('without ancestorOrigins', () => {
        const flushPing = async () => {
            await Promise.resolve();
        };

        test('Should attach the bundle for a Datadog parent that answers its ping', async () => {
            const { postMessage, posted, reply, pings, pong } = installFakeWindow({});
            mockFetchResponse({ ok: true, json: async () => BUNDLE });

            const result = postMessageTransport(QUERY_NAME, ARGS);
            await flushPing();
            const [ping, ...otherPings] = pings();
            expect(otherPings).toHaveLength(0);
            expect(postMessage).toHaveBeenCalledWith(ping, '*');
            pong(DATADOG_PARENT);
            const message = await posted;
            reply(message.requestId, 'ok');

            await expect(result).resolves.toBe('ok');
            expect(message).toEqual({ ...MESSAGE_WITHOUT_BUNDLE, bundle: BUNDLE });
            expect(postMessage).toHaveBeenCalledWith(message, DATADOG_PARENT);
        });

        test('Should send the call without a bundle when a non-Datadog parent answers', async () => {
            const { postMessage, posted, reply, pong } = installFakeWindow({});
            mockFetchResponse({ ok: true, json: async () => BUNDLE });

            const result = postMessageTransport(QUERY_NAME, ARGS);
            await flushPing();
            pong('https://example.com');
            const message = await posted;
            reply(message.requestId, 'ok');

            await expect(result).resolves.toBe('ok');
            expect(global.fetch).not.toHaveBeenCalled();
            expect(postMessage).toHaveBeenCalledWith(message, '*');
        });

        test('Should ignore a pong from any window but the parent', async () => {
            jest.useFakeTimers();
            const { postMessage, posted, reply, pong } = installFakeWindow({});
            mockFetchResponse({ ok: true, json: async () => BUNDLE });

            const result = postMessageTransport(QUERY_NAME, ARGS);
            await flushPing();
            pong(DATADOG_PARENT, {});
            await jest.advanceTimersByTimeAsync(PARENT_PING_TIMEOUT_MS);
            const message = await posted;
            reply(message.requestId, 'ok');

            await expect(result).resolves.toBe('ok');
            expect(global.fetch).not.toHaveBeenCalled();
            expect(postMessage).toHaveBeenCalledWith(message, '*');
        });

        test('Should send the call without a bundle when the parent never answers', async () => {
            jest.useFakeTimers();
            const { postMessage, posted, reply, listenerCount } = installFakeWindow({});
            mockFetchResponse({ ok: true, json: async () => BUNDLE });

            const result = postMessageTransport(QUERY_NAME, ARGS);
            await flushPing();
            await jest.advanceTimersByTimeAsync(PARENT_PING_TIMEOUT_MS);
            const message = await posted;
            reply(message.requestId, 'ok');

            await expect(result).resolves.toBe('ok');
            expect(global.fetch).not.toHaveBeenCalled();
            expect(postMessage).toHaveBeenCalledWith(message, '*');
            const remainingListeners = listenerCount();
            expect(remainingListeners).toBe(0);
        });

        test('Should ping the parent once per page', async () => {
            const { postMessage, posted, reply, pings, pong } = installFakeWindow({});
            mockFetchResponse({ ok: true, json: async () => BUNDLE });

            const first = postMessageTransport(QUERY_NAME, ARGS);
            await flushPing();
            pong(DATADOG_PARENT);
            const firstMessage = await posted;
            reply(firstMessage.requestId, 'first');
            await expect(first).resolves.toBe('first');

            const second = postMessageTransport(QUERY_NAME, ARGS);
            await new Promise((resolve) => setImmediate(resolve));
            const [secondMessage] = postMessage.mock.calls.at(-1);
            reply(secondMessage.requestId, 'second');

            await expect(second).resolves.toBe('second');
            const sentPings = pings();
            expect(sentPings).toHaveLength(1);
            expect(secondMessage).toEqual({ ...MESSAGE_WITHOUT_BUNDLE, bundle: BUNDLE });
        });
    });

    describe('without ancestorOrigins, across calls', () => {
        test('Should share one ping between calls made before the parent answers', async () => {
            const { postMessage, reply, pings, pong } = installFakeWindow({});
            mockFetchResponse({ ok: true, json: async () => BUNDLE });

            const first = postMessageTransport(QUERY_NAME, ARGS);
            const second = postMessageTransport(QUERY_NAME, ARGS);
            await Promise.resolve();
            const sentPings = pings();
            expect(sentPings).toHaveLength(1);
            pong(DATADOG_PARENT);
            await new Promise((resolve) => setImmediate(resolve));

            const queries = postMessage.mock.calls
                .map(([message]: [PostedMessage]) => message)
                .filter((message) => message.type === 'app-builder:run-query');
            expect(queries).toHaveLength(2);
            for (const query of queries) {
                expect(query).toEqual({ ...MESSAGE_WITHOUT_BUNDLE, bundle: BUNDLE });
                reply(query.requestId, 'ok');
            }
            await expect(first).resolves.toBe('ok');
            await expect(second).resolves.toBe('ok');
        });

        test('Should ping again on a later call after the parent did not answer', async () => {
            jest.useFakeTimers();
            const { postMessage, reply, pings } = installFakeWindow({});
            mockFetchResponse({ ok: true, json: async () => BUNDLE });

            const first = postMessageTransport(QUERY_NAME, ARGS);
            await jest.advanceTimersByTimeAsync(PARENT_PING_TIMEOUT_MS);
            const [firstQuery] = postMessage.mock.calls.at(-1);
            reply(firstQuery.requestId, 'first');
            await expect(first).resolves.toBe('first');

            const second = postMessageTransport(QUERY_NAME, ARGS);
            await jest.advanceTimersByTimeAsync(0);
            const sentPings = pings();
            expect(sentPings).toHaveLength(2);
            await jest.advanceTimersByTimeAsync(PARENT_PING_TIMEOUT_MS);
            const [secondQuery] = postMessage.mock.calls.at(-1);
            reply(secondQuery.requestId, 'second');
            await expect(second).resolves.toBe('second');
        });
    });

    test('Should ignore a run-query response from any window but the parent', async () => {
        const { posted, reply } = installFakeWindow();
        mockFetchResponse({ ok: true, json: async () => BUNDLE });

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

    test('Should not ping a parent that ancestorOrigins already names', async () => {
        const { postMessage, posted, reply, pings } = installFakeWindow();
        mockFetchResponse({ ok: true, json: async () => BUNDLE });

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        const sentPings = pings();
        expect(sentPings).toHaveLength(0);
        expect(message).toHaveProperty('bundle', BUNDLE);
        expect(postMessage).toHaveBeenCalledWith(message, DATADOG_PARENT);
    });

    test('Should neither ping nor fetch a bundle when ancestorOrigins is empty', async () => {
        const { posted, reply, pings } = installFakeWindow({ ancestorOrigins: [] });
        mockFetchResponse({ ok: true, json: async () => BUNDLE });

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        const sentPings = pings();
        expect(sentPings).toHaveLength(0);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('Should not fetch a bundle in a deployed app', async () => {
        Reflect.deleteProperty(globalThis, DEV_SERVER_MARKER);
        const { postMessage, posted, reply } = installFakeWindow();
        mockFetchResponse({ ok: true, json: async () => BUNDLE });

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        expect(global.fetch).not.toHaveBeenCalled();
        expect(message).not.toHaveProperty('bundle');
        expect(postMessage).toHaveBeenCalledWith(message, '*');
        expect(warn).not.toHaveBeenCalled();
    });

    test('Should request the bundle as JSON', async () => {
        const { posted, reply } = installFakeWindow();
        mockFetchResponse({ ok: true, json: async () => BUNDLE });

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');
        await result;

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(global.fetch).toHaveBeenCalledWith(DEBUG_BUNDLE_PATH, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ functionName: QUERY_NAME }),
            signal: expect.any(AbortSignal),
        });
    });

    test('Should forward only the bundle fields the parent reads', async () => {
        const { posted, reply } = installFakeWindow();
        mockFetchResponse({ ok: true, json: async () => ({ ...BUNDLE, extra: 'ignored' }) });

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');
        await result;

        expect(message).toHaveProperty('bundle', BUNDLE);
    });

    const failureCases = [
        {
            description: 'the fetch rejects',
            setup: () => {
                global.fetch = jest.fn().mockRejectedValue(new Error('Failed to fetch'));
            },
        },
        {
            description: 'the dev server responds with an error status',
            setup: () =>
                mockFetchResponse({
                    ok: false,
                    status: 500,
                    json: async () => ({ error: 'boom' }),
                }),
        },
        {
            description: 'the dev server responds with an error status and no JSON body',
            setup: () =>
                mockFetchResponse({
                    ok: false,
                    status: 502,
                    json: async () => {
                        throw new SyntaxError('Unexpected token');
                    },
                }),
        },
        {
            description: 'the response is not JSON',
            setup: () =>
                mockFetchResponse({
                    ok: true,
                    json: async () => {
                        throw new SyntaxError('Unexpected token');
                    },
                }),
        },
        {
            description: 'the response lacks connection IDs',
            setup: () => mockFetchResponse({ ok: true, json: async () => ({ code: '// code' }) }),
        },
        {
            description: 'the bundled code is empty',
            setup: () =>
                mockFetchResponse({
                    ok: true,
                    json: async () => ({ code: '', allowedConnectionIds: [] }),
                }),
        },
        {
            description: 'the connection IDs are not all strings',
            setup: () =>
                mockFetchResponse({
                    ok: true,
                    json: async () => ({ code: '// code', allowedConnectionIds: [1] }),
                }),
        },
    ];

    test.each(failureCases)(
        'Should still send the call without a bundle when $description',
        async ({ setup }) => {
            const { postMessage, posted, reply } = installFakeWindow();
            setup();

            const result = postMessageTransport(QUERY_NAME, ARGS);
            const message = await posted;
            reply(message.requestId, 'ok');

            await expect(result).resolves.toBe('ok');
            expect(message).toEqual(MESSAGE_WITHOUT_BUNDLE);
            expect(postMessage).toHaveBeenCalledWith(message, DATADOG_PARENT);
            expect(warn).toHaveBeenCalledTimes(1);
            const namesTheFunction = expect.stringContaining(QUERY_NAME);
            expect(warn).toHaveBeenCalledWith(namesTheFunction);
        },
    );

    test("Should warn with the dev server's error when it rejects the bundle request", async () => {
        const { postMessage, posted, reply } = installFakeWindow();
        const serverError = 'Backend function "greet" imports restricted module "fs"';
        mockFetchResponse({
            ok: false,
            status: 400,
            json: async () => ({ success: false, error: serverError }),
        });

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        expect(message).toEqual(MESSAGE_WITHOUT_BUNDLE);
        expect(postMessage).toHaveBeenCalledWith(message, DATADOG_PARENT);
        expect(warn).toHaveBeenCalledTimes(1);
        const namesTheStatus = expect.stringContaining('400');
        const namesTheServerError = expect.stringContaining(serverError);
        expect(warn).toHaveBeenCalledWith(namesTheStatus);
        expect(warn).toHaveBeenCalledWith(namesTheServerError);
    });

    test('Should warn with the network error when the bundle request fails', async () => {
        const { postMessage, posted, reply } = installFakeWindow();
        global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        expect(message).toEqual(MESSAGE_WITHOUT_BUNDLE);
        expect(postMessage).toHaveBeenCalledWith(message, DATADOG_PARENT);
        expect(warn).toHaveBeenCalledTimes(1);
        const namesTheNetworkError = expect.stringContaining('Failed to fetch');
        expect(warn).toHaveBeenCalledWith(namesTheNetworkError);
    });

    test('Should reject the call and stop waiting when the message cannot be posted', async () => {
        jest.useFakeTimers();
        const { postMessage, listenerCount } = installFakeWindow();
        const cloneError = new Error('could not be cloned');
        postMessage.mockImplementation(() => {
            throw cloneError;
        });
        mockFetchResponse({ ok: true, json: async () => BUNDLE });

        const result = postMessageTransport(QUERY_NAME, ARGS);

        await expect(result).rejects.toBe(cloneError);
        const remainingListeners = listenerCount();
        const remainingTimers = jest.getTimerCount();
        expect(remainingListeners).toBe(0);
        expect(remainingTimers).toBe(0);
    });

    test('Should abort a stalled bundle fetch and send the call without a bundle', async () => {
        jest.useFakeTimers();
        const { posted, reply } = installFakeWindow();
        let fetchSignal: AbortSignal | undefined;
        global.fetch = jest.fn().mockImplementation(
            (_url: string, init: { signal: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    fetchSignal = init.signal;
                    init.signal.addEventListener('abort', () => reject(init.signal.reason));
                }),
        );

        const result = postMessageTransport(QUERY_NAME, ARGS);
        await jest.advanceTimersByTimeAsync(BUNDLE_FETCH_TIMEOUT_MS);
        const message = await posted;
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
        expect(fetchSignal?.aborted).toBe(true);
        expect(message).not.toHaveProperty('bundle');
        expect(warn).toHaveBeenCalledTimes(1);
        const timeoutWarning = expect.stringContaining(
            `timed out after ${BUNDLE_FETCH_TIMEOUT_MS}ms`,
        );
        expect(warn).toHaveBeenCalledWith(timeoutWarning);
    });

    test('Should give the parent its full response window after the bundle arrives', async () => {
        jest.useFakeTimers();
        const { posted, reply } = installFakeWindow();
        const bundleDelayMs = BUNDLE_FETCH_TIMEOUT_MS - 1;
        global.fetch = jest.fn().mockImplementation(
            () =>
                new Promise<FakeResponse>((resolve) => {
                    setTimeout(
                        () => resolve({ ok: true, json: async () => BUNDLE }),
                        bundleDelayMs,
                    );
                }),
        );

        const result = postMessageTransport(QUERY_NAME, ARGS);
        await jest.advanceTimersByTimeAsync(bundleDelayMs);
        const message = await posted;
        await jest.advanceTimersByTimeAsync(POSTMESSAGE_TIMEOUT_MS - 1);
        reply(message.requestId, 'ok');

        await expect(result).resolves.toBe('ok');
    });
});
