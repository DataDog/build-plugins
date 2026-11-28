// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { trackNetwork } from './measure';

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
