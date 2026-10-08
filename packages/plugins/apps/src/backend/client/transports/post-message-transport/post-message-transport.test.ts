// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import { DEBUG_BUNDLE_PATH } from '../../../protocol';

import {
    BUNDLE_FETCH_TIMEOUT_MS,
    POSTMESSAGE_TIMEOUT_MS,
    postMessageTransport,
} from './post-message-transport';

type MessageListener = (event: { data: unknown }) => void;

const QUERY_NAME = 'backend/greet.greet';
const ARGS = ['world', 42];
const BUNDLE = { code: 'export async function main($) {}', allowedConnectionIds: ['conn-1'] };

// The node-only jest harness has no DOM, so a minimal stand-in covers what the transport touches.
function installFakeWindow() {
    const listeners = new Set<MessageListener>();
    const postMessage = jest.fn();
    const fakeWindow = {
        addEventListener: (_type: string, listener: MessageListener) => listeners.add(listener),
        removeEventListener: (_type: string, listener: MessageListener) =>
            listeners.delete(listener),
        parent: { postMessage },
    };
    Object.defineProperty(globalThis, 'window', {
        value: fakeWindow,
        configurable: true,
        writable: true,
    });

    const posted = new Promise<{ requestId: string }>((resolve) => {
        postMessage.mockImplementation(resolve);
    });
    const reply = (requestId: string, data: unknown) => {
        for (const listener of [...listeners]) {
            listener({
                data: {
                    type: 'app-builder:run-query:response',
                    requestId,
                    success: true,
                    result: { data },
                },
            });
        }
    };

    return { postMessage, posted, reply };
}

type FakeResponse = { ok: boolean; json: () => Promise<unknown> };

function mockFetchResponse(response: FakeResponse) {
    global.fetch = jest.fn().mockResolvedValue(response);
}

describe('postMessageTransport', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        Reflect.deleteProperty(globalThis, 'window');
        jest.useRealTimers();
    });

    test('Should attach its own dev server bundle to the run-query message', async () => {
        const { posted, reply } = installFakeWindow();
        mockFetchResponse({ ok: true, json: async () => BUNDLE });

        const result = postMessageTransport(QUERY_NAME, ARGS);
        const message = await posted;
        reply(message.requestId, { greeting: 'hi' });

        await expect(result).resolves.toEqual({ greeting: 'hi' });
        expect(message).toEqual({
            type: 'app-builder:run-query',
            requestId: expect.any(String),
            queryName: QUERY_NAME,
            args: ARGS,
            bundle: BUNDLE,
        });
    });

    test('Should fetch the bundle from a relative URL', () => {
        expect(DEBUG_BUNDLE_PATH.startsWith('/')).toBe(false);
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
            setup: () => mockFetchResponse({ ok: false, json: async () => ({ error: 'boom' }) }),
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
            const { posted, reply } = installFakeWindow();
            setup();

            const result = postMessageTransport(QUERY_NAME, ARGS);
            const message = await posted;
            reply(message.requestId, 'ok');

            await expect(result).resolves.toBe('ok');
            expect(message).toEqual({
                type: 'app-builder:run-query',
                requestId: expect.any(String),
                queryName: QUERY_NAME,
                args: ARGS,
            });
        },
    );

    test('Should reject the call when the message cannot be posted', async () => {
        const { postMessage } = installFakeWindow();
        const cloneError = new Error('could not be cloned');
        postMessage.mockImplementation(() => {
            throw cloneError;
        });
        mockFetchResponse({ ok: true, json: async () => BUNDLE });

        await expect(postMessageTransport(QUERY_NAME, ARGS)).rejects.toBe(cloneError);
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
