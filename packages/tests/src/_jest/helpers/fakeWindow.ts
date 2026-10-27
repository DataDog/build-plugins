// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import { PING, PONG, RUN_QUERY, RUN_QUERY_RESPONSE } from '@dd/apps-plugin/backend/protocol';

type MessageListener = (event: { data: unknown; origin?: string; source?: unknown }) => void;
export type PostedMessage = { type: string; requestId: string };

export const QUERY_NAME = 'backend/greet.greet';
export const ARGS = ['world', 42];
export const BUNDLE = {
    code: 'export async function main($) {}',
    allowedConnectionIds: ['conn-1'],
};
export const DATADOG_PARENT = 'https://app.datadoghq.com';

// The node-only jest harness has no DOM, so a minimal stand-in covers what the transport touches.
export function installFakeWindow(
    location: { ancestorOrigins?: string[] | null } = { ancestorOrigins: [DATADOG_PARENT] },
    parentOrigin = location.ancestorOrigins?.[0] ?? DATADOG_PARENT,
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
            if (message.type === RUN_QUERY) {
                resolve(message);
            }
        });
    });
    const pings = () =>
        postMessage.mock.calls
            .map(([message]: [PostedMessage]) => message)
            .filter((message) => message.type === PING);
    const pong = (origin = parentOrigin, source: unknown = fakeWindow.parent) => {
        const ping = pings().at(-1);
        for (const listener of [...listeners]) {
            listener({
                data: { type: PONG, requestId: ping?.requestId },
                origin,
                source,
            });
        }
    };
    const reply = (
        requestId: string,
        data: unknown,
        source: unknown = fakeWindow.parent,
        origin = parentOrigin,
    ) => {
        for (const listener of [...listeners]) {
            listener({
                data: {
                    type: RUN_QUERY_RESPONSE,
                    requestId,
                    success: true,
                    result: { data },
                },
                origin,
                source,
            });
        }
    };

    return {
        postMessage,
        posted,
        reply,
        pings,
        pong,
        listeners: () => [...listeners],
        parent: fakeWindow.parent,
        listenerCount: () => listeners.size,
    };
}

export type FakeResponse = { ok: boolean; status?: number; json: () => Promise<unknown> };

export function mockFetchResponse(response: FakeResponse) {
    global.fetch = jest.fn().mockResolvedValue(response);
}

export const MESSAGE_WITHOUT_BUNDLE = {
    type: RUN_QUERY,
    requestId: expect.any(String),
    queryName: QUERY_NAME,
    args: ARGS,
};
