// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { setTimeout as wait } from 'timers/promises';

import type { Chrome, ChromePage } from './chrome';
import { measureLoad, trackNetwork } from './measure';

type Listener = (params: unknown) => void;

const createFakePage = () => {
    const listeners = new Map<string, Listener>();
    return {
        page: {
            on: (method: string, listener: Listener) => {
                listeners.set(method, listener);
                return () => {
                    listeners.delete(method);
                };
            },
        },
        emit: (method: string, params: unknown) => listeners.get(method)?.(params),
    };
};

const loadScript = (
    emit: (method: string, params: unknown) => void,
    requestId: string,
    url: string,
    { decodedBytes, status = 200 }: { decodedBytes: number; status?: number },
): void => {
    emit('Network.requestWillBeSent', { requestId, type: 'Script', request: { url } });
    emit('Network.responseReceived', { requestId, type: 'Script', response: { status } });
    emit('Network.dataReceived', { requestId, dataLength: decodedBytes });
    emit('Network.loadingFinished', { requestId, encodedDataLength: decodedBytes / 2 });
};

describe('runtime network tracking', () => {
    test("should count only the page origin's scripts, and its failed requests", () => {
        const { page, emit } = createFakePage();
        const network = trackNetwork(page, 'http://127.0.0.1:4000');
        loadScript(emit, '1', 'http://127.0.0.1:4000/assets/app.js', { decodedBytes: 1_000 });
        // Same prefix, another port.
        loadScript(emit, '2', 'http://127.0.0.1:40001/assets/other.js', { decodedBytes: 500 });
        loadScript(emit, '3', 'https://cdn.example.com/lib.js', { decodedBytes: 200 });
        loadScript(emit, '4', 'http://127.0.0.1:4000/assets/missing.js', {
            decodedBytes: 100,
            status: 404,
        });

        expect(network.summarize()).toEqual({
            failedRequests: 1,
            jsDecodedBytes: 1_000,
            jsRequests: 1,
            jsTransferBytes: 500,
        });
        expect(network.getInFlight()).toBe(0);
    });
});

describe('runtime page loads', () => {
    const page = { id: 'home', path: '/', readySelector: 'main' };

    // A page that answers every command at once, except that it says the ready
    // selector is visible only after visibleAfterMs.
    const createChrome = (visibleAfterMs: number): Chrome => ({
        version: 'HeadlessChrome/1',
        close: async () => undefined,
        newPage: async (): Promise<ChromePage> => ({
            send: async (method, params) => {
                const expression = typeof params?.expression === 'string' ? params.expression : '';
                if (method === 'Runtime.evaluate' && expression.includes('getBoundingClientRect')) {
                    await wait(visibleAfterMs);
                    return { result: { value: true } };
                }
                return {};
            },
            on: () => () => undefined,
            waitFor: async () => ({}),
            close: async () => undefined,
        }),
    });

    const load = (chrome: Chrome, signal?: AbortSignal) =>
        measureLoad({
            cache: 'cold',
            chrome,
            cookies: [],
            cpuThrottling: 1,
            lcpSettleMs: 10,
            maxWaitMs: 50,
            network: null,
            origin: 'http://127.0.0.1:9',
            page,
            signal,
        });

    test('should fail a load whose page becomes ready only after its time limit', async () => {
        const result = await load(createChrome(150));
        expect(result.error).toBe("main wasn't visible in time.");
    });

    test('should send nothing once the run was stopped', async () => {
        const controller = new AbortController();
        controller.abort();
        const chrome = createChrome(0);
        const newPage = chrome.newPage;
        const sent: string[] = [];
        const tracked: Chrome = {
            ...chrome,
            newPage: async () => {
                const fakePage = await newPage();
                return {
                    ...fakePage,
                    send: (method, params) => {
                        sent.push(method);
                        return fakePage.send(method, params);
                    },
                };
            },
        };

        await expect(load(tracked, controller.signal)).rejects.toThrow();
        expect(sent).toEqual([]);
    });
});
