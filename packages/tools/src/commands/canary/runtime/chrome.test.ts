// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, rm } from '@dd/core/helpers/fs';
// The core helpers can't set file modes.
import { chmod } from 'fs/promises';
import os from 'os';
import path from 'path';

import {
    CHROME_PATH_ENV,
    ChromeConnectionError,
    connect,
    createSession,
    findChrome,
    getNumber,
} from './chrome';

const TEST_ROOT = path.resolve(os.tmpdir(), `build-plugins-canary-chrome-${process.pid}`);
const FIRST_BIN = path.resolve(TEST_ROOT, 'first');
const SECOND_BIN = path.resolve(TEST_ROOT, 'second');

const createFile = async (filePath: string, mode: number): Promise<string> => {
    await outputFile(filePath, '#!/bin/sh\n');
    await chmod(filePath, mode);
    return filePath;
};

describe('Chrome lookup', () => {
    let firstChromium: string;
    let secondChrome: string;
    let notExecutable: string;

    beforeAll(async () => {
        await rm(TEST_ROOT);
        firstChromium = await createFile(path.resolve(FIRST_BIN, 'chromium'), 0o755);
        secondChrome = await createFile(path.resolve(SECOND_BIN, 'google-chrome'), 0o755);
        notExecutable = await createFile(path.resolve(FIRST_BIN, 'google-chrome'), 0o644);
    });

    afterAll(async () => {
        await rm(TEST_ROOT);
    });

    test('should prefer the explicit path over the environment', async () => {
        const chromePath = await findChrome({
            env: { [CHROME_PATH_ENV]: secondChrome, PATH: FIRST_BIN },
            explicitPath: firstChromium,
        });
        expect(chromePath).toBe(firstChromium);
    });

    test(`should use ${CHROME_PATH_ENV} before PATH`, async () => {
        const chromePath = await findChrome({
            env: { [CHROME_PATH_ENV]: secondChrome, PATH: FIRST_BIN },
            explicitPath: undefined,
        });
        expect(chromePath).toBe(secondChrome);
    });

    test('should prefer google-chrome on PATH and skip files that are not executable', async () => {
        const searchPath = [FIRST_BIN, SECOND_BIN].join(path.delimiter);
        const chromePath = await findChrome({ env: { PATH: searchPath }, explicitPath: undefined });
        // FIRST_BIN's google-chrome isn't executable, so SECOND_BIN's wins over chromium.
        expect(chromePath).toBe(secondChrome);
    });

    test('should fall back to chromium on PATH', async () => {
        const chromePath = await findChrome({ env: { PATH: FIRST_BIN }, explicitPath: undefined });
        expect(chromePath).toBe(firstChromium);
    });

    test('should explain how to set Chrome when it finds none', async () => {
        const emptyPath = path.resolve(TEST_ROOT, 'empty');
        const lookup = findChrome({ env: { PATH: emptyPath }, explicitPath: undefined });
        await expect(lookup).rejects.toThrow(CHROME_PATH_ENV);
    });

    test('should reject a configured path that is not executable', async () => {
        const lookup = findChrome({ env: {}, explicitPath: notExecutable });
        await expect(lookup).rejects.toThrow("isn't executable");
    });
});

type FakeEvent = { data?: unknown };

// Stands in for Node.js's WebSocket, so the DevTools client runs without Chrome.
class FakeSocket {
    static latest: FakeSocket | undefined;
    static failSends = false;
    readonly sent: string[] = [];
    private readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();

    constructor() {
        FakeSocket.latest = this;
    }

    addEventListener(type: string, listener: (event: FakeEvent) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    send(data: string): void {
        if (FakeSocket.failSends) {
            throw new Error('The socket is not open.');
        }
        this.sent.push(data);
    }

    close(): void {
        this.emit('close');
    }

    emit(type: string, event: FakeEvent = {}): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

const getSocket = (): FakeSocket => {
    if (!FakeSocket.latest) {
        throw new Error('No socket was opened.');
    }
    return FakeSocket.latest;
};

const openSession = async () => {
    const connecting = connect('ws://127.0.0.1:9222/devtools/browser/test');
    getSocket().emit('open');
    const connection = await connecting;
    return createSession(connection, 'session-1');
};

describe('DevTools connection', () => {
    const originalWebSocket: unknown = Reflect.get(global, 'WebSocket');

    beforeEach(() => {
        FakeSocket.latest = undefined;
        FakeSocket.failSends = false;
        Reflect.set(global, 'WebSocket', FakeSocket);
    });

    afterEach(() => {
        Reflect.set(global, 'WebSocket', originalWebSocket);
    });

    test('should resolve a command with its result and a wait with its event', async () => {
        const session = await openSession();
        const command = session.send('Runtime.evaluate', { expression: '1' });
        const sent: unknown = JSON.parse(getSocket().sent[0] ?? '{}');
        const id = getNumber(sent, 'id');
        getSocket().emit('message', { data: JSON.stringify({ id, result: { value: 1 } }) });

        await expect(command).resolves.toEqual({ value: 1 });

        const waiting = session.waitFor('Page.loadEventFired', 60_000);
        const event = { method: 'Page.loadEventFired', sessionId: 'session-1', params: { t: 1 } };
        getSocket().emit('message', { data: JSON.stringify(event) });

        await expect(waiting).resolves.toEqual({ t: 1 });
    });

    test('should fail pending and later commands and waits once the connection closes', async () => {
        const session = await openSession();
        const command = session.send('Page.navigate', { url: 'http://127.0.0.1/' });
        const waiting = session.waitFor('Page.loadEventFired', 60_000);
        getSocket().emit('close');

        await expect(command).rejects.toBeInstanceOf(ChromeConnectionError);
        await expect(waiting).rejects.toBeInstanceOf(ChromeConnectionError);
        await expect(session.send('Page.reload')).rejects.toBeInstanceOf(ChromeConnectionError);
        const later = session.waitFor('Page.loadEventFired', 60_000);
        await expect(later).rejects.toBeInstanceOf(ChromeConnectionError);
    });

    test('should cancel waits when asked, for example when their page closes', async () => {
        const session = await openSession();
        const waiting = session.waitFor('Page.loadEventFired', 60_000);
        session.cancel(new Error('The page closed.'));

        await expect(waiting).rejects.toThrow('The page closed.');
    });

    test('should fail a command the socket cannot send as a connection error', async () => {
        const session = await openSession();
        FakeSocket.failSends = true;

        await expect(session.send('Page.reload')).rejects.toBeInstanceOf(ChromeConnectionError);
    });
});

describe('DevTools connection timeouts and cancellation', () => {
    const originalWebSocket: unknown = Reflect.get(global, 'WebSocket');

    beforeEach(() => {
        FakeSocket.latest = undefined;
        FakeSocket.failSends = false;
        Reflect.set(global, 'WebSocket', FakeSocket);
    });

    afterEach(() => {
        jest.useRealTimers();
        Reflect.set(global, 'WebSocket', originalWebSocket);
    });

    const openConnection = async () => {
        const connecting = connect('ws://127.0.0.1:9222/devtools/browser/test');
        getSocket().emit('open');
        return connecting;
    };

    test("should treat the browser's own commands timing out as Chrome failing", async () => {
        jest.useFakeTimers();
        const connection = await openConnection();
        const browser = createSession(connection, undefined).send('Target.createTarget');
        const page = createSession(connection, 'session-1').send('Runtime.evaluate');
        jest.advanceTimersByTime(120_000);
        // Settles both first, so neither rejection goes unhandled if one check fails.
        const [browserOutcome, pageOutcome] = await Promise.allSettled([browser, page]);

        expect(browserOutcome).toMatchObject({
            status: 'rejected',
            reason: expect.any(ChromeConnectionError),
        });
        expect(pageOutcome).toMatchObject({
            status: 'rejected',
            reason: expect.objectContaining({
                message: 'Runtime.evaluate got no answer within 120s.',
            }),
        });
        expect(pageOutcome).not.toMatchObject({ reason: expect.any(ChromeConnectionError) });
    });

    test("should reject a cancelled session's commands, and only its own", async () => {
        const connection = await openConnection();
        const first = createSession(connection, 'session-1');
        const second = createSession(connection, 'session-2');
        const cancelled = first.send('Runtime.evaluate');
        const other = second.send('Runtime.evaluate');
        first.cancel(new Error('The page closed.'));

        await expect(cancelled).rejects.toThrow('The page closed.');
        const sent: unknown = JSON.parse(getSocket().sent[1] ?? '{}');
        const id = getNumber(sent, 'id');
        getSocket().emit('message', { data: JSON.stringify({ id, result: { value: 2 } }) });
        await expect(other).resolves.toEqual({ value: 2 });
    });

    test('should fail to connect when the socket closes before it opens', async () => {
        const connecting = connect('ws://127.0.0.1:9222/devtools/browser/test');
        getSocket().emit('close');

        await expect(connecting).rejects.toBeInstanceOf(ChromeConnectionError);
    });
});
