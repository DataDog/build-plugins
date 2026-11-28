// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { access, constants, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Launches headless Chrome and talks the Chrome DevTools Protocol to it over
// Node's own WebSocket.

export const CHROME_PATH_ENV = 'CANARY_CHROME_PATH';
const CHROME_COMMANDS = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'chrome',
];
const WINDOW_SIZE = { width: 1280, height: 800 };
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 120_000;
const STDERR_TAIL_LENGTH = 4_000;
const DEVTOOLS_URL = /DevTools listening on (ws:\/\/\S+)/;

// Makes every host name fail to resolve, so pages only reach servers on
// 127.0.0.1 and runs don't depend on third-party services.
export const BLOCK_EXTERNAL_HOSTS_FLAG = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1';

// Quiets the features that make background requests or change behaviour between
// runs. Extra flags come after these, so callers can override them.
export const DEFAULT_CHROME_FLAGS = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--password-store=basic',
    '--use-mock-keychain',
    `--window-size=${WINDOW_SIZE.width},${WINDOW_SIZE.height}`,
];

type Listener = (params: unknown) => void;

type WebSocketEvent = {
    data?: unknown;
};

type WebSocketLike = {
    addEventListener: (
        type: 'open' | 'message' | 'close' | 'error',
        listener: (event: WebSocketEvent) => void,
    ) => void;
    send: (data: string) => void;
    close: () => void;
};

type WebSocketConstructor = new (url: string) => WebSocketLike;

type PendingCommand = {
    method: string;
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

export type CdpSession = {
    send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    // Returns a function that removes the listener.
    on: (method: string, listener: Listener) => () => void;
    waitFor: (method: string, timeoutMs: number) => Promise<unknown>;
};

export type ChromePage = CdpSession & {
    close: () => Promise<void>;
};

export type Chrome = {
    version: string;
    newPage: () => Promise<ChromePage>;
    close: () => Promise<void>;
};

export const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

export const getString = (value: unknown, key: string): string | undefined => {
    const field = isRecord(value) ? value[key] : undefined;
    return typeof field === 'string' ? field : undefined;
};

export const getNumber = (value: unknown, key: string): number | undefined => {
    const field = isRecord(value) ? value[key] : undefined;
    return typeof field === 'number' ? field : undefined;
};

const getRequiredString = (value: unknown, key: string, method: string): string => {
    const field = getString(value, key);
    if (field === undefined) {
        throw new Error(`Chrome's ${method} response has no ${key}.`);
    }
    return field;
};

const isWebSocketConstructor = (value: unknown): value is WebSocketConstructor => {
    return typeof value === 'function';
};

const getWebSocketConstructor = (): WebSocketConstructor => {
    const candidate: unknown = Reflect.get(global, 'WebSocket');
    if (!isWebSocketConstructor(candidate)) {
        throw new Error('This Node.js has no global WebSocket. Use Node.js 22 or later.');
    }
    return candidate;
};

const isExecutable = async (filePath: string): Promise<boolean> => {
    try {
        await access(filePath, constants.X_OK);
        return true;
    } catch {
        return false;
    }
};

// Uses the given path, then CANARY_CHROME_PATH, then the first Chrome or Chromium
// on PATH.
export const findChrome = async ({
    env,
    explicitPath,
}: {
    env: Record<string, string | undefined>;
    explicitPath: string | undefined;
}): Promise<string> => {
    const configuredPath = explicitPath ?? env[CHROME_PATH_ENV];
    if (configuredPath) {
        if (!(await isExecutable(configuredPath))) {
            throw new Error(`Chrome at ${configuredPath} doesn't exist or isn't executable.`);
        }
        return configuredPath;
    }

    const searchPath = env.PATH ?? '';
    const directories = searchPath.split(path.delimiter).filter(Boolean);
    for (const command of CHROME_COMMANDS) {
        for (const directory of directories) {
            const candidate = path.join(directory, command);
            if (await isExecutable(candidate)) {
                return candidate;
            }
        }
    }
    throw new Error(
        `Found no Chrome. Set ${CHROME_PATH_ENV}, or put one of ${CHROME_COMMANDS.join(', ')} on PATH.`,
    );
};

const getChromeFlags = (userDataDirectory: string, extraFlags: string[]): string[] => {
    // Chrome refuses to run as root, as in CI containers, without its sandbox off.
    const runsAsRoot = process.getuid?.() === 0;
    const sandboxFlags = runsAsRoot ? ['--no-sandbox'] : [];
    return [
        ...DEFAULT_CHROME_FLAGS,
        ...sandboxFlags,
        `--user-data-dir=${userDataDirectory}`,
        ...extraFlags,
        'about:blank',
    ];
};

// Chrome prints its DevTools URL to stderr once it listens.
const readDevToolsUrl = (child: ChildProcess, getStderr: () => string): Promise<string> => {
    return new Promise((resolve, reject) => {
        const cleanup = (): void => {
            clearTimeout(timeout);
            child.stderr?.off('data', onData);
            child.off('exit', onExit);
            child.off('error', onError);
        };
        const onData = (): void => {
            const match = DEVTOOLS_URL.exec(getStderr());
            if (match?.[1]) {
                cleanup();
                resolve(match[1]);
            }
        };
        const onExit = (code: number | null, signal: string | null): void => {
            cleanup();
            const outcome = signal ? `signal ${signal}` : `exit code ${code}`;
            const error = new Error(
                `Chrome exited with ${outcome} before it started:\n${getStderr()}`,
            );
            reject(error);
        };
        const onError = (error: Error): void => {
            cleanup();
            reject(error);
        };
        const timeout = setTimeout(() => {
            cleanup();
            const error = new Error(`Chrome didn't start within ${STARTUP_TIMEOUT_MS / 1_000}s.`);
            reject(error);
        }, STARTUP_TIMEOUT_MS);
        child.stderr?.on('data', onData);
        child.once('exit', onExit);
        child.once('error', onError);
    });
};

type Connection = {
    send: (
        method: string,
        params: Record<string, unknown>,
        sessionId: string | undefined,
    ) => Promise<unknown>;
    on: (method: string, sessionId: string | undefined, listener: Listener) => () => void;
    close: () => void;
};

const getListenerKey = (method: string, sessionId: string | undefined): string => {
    return `${sessionId ?? ''}:${method}`;
};

const connect = (url: string): Promise<Connection> => {
    const WebSocketClass = getWebSocketConstructor();
    const socket = new WebSocketClass(url);
    const pending = new Map<number, PendingCommand>();
    const listeners = new Map<string, Set<Listener>>();
    let nextId = 1;
    let closedError: Error | undefined;

    const rejectAll = (error: Error): void => {
        closedError = error;
        for (const command of pending.values()) {
            clearTimeout(command.timeout);
            command.reject(error);
        }
        pending.clear();
    };

    const handleMessage = (data: unknown): void => {
        if (typeof data !== 'string') {
            return;
        }
        const message: unknown = JSON.parse(data);
        const id = getNumber(message, 'id');
        if (id !== undefined) {
            const command = pending.get(id);
            if (!command) {
                return;
            }
            pending.delete(id);
            clearTimeout(command.timeout);
            const error = isRecord(message) ? message.error : undefined;
            if (error !== undefined) {
                const errorMessage = getString(error, 'message') ?? JSON.stringify(error);
                const commandError = new Error(`${command.method}: ${errorMessage}`);
                command.reject(commandError);
                return;
            }
            const result = isRecord(message) ? message.result : undefined;
            command.resolve(result);
            return;
        }

        const method = getString(message, 'method');
        if (method === undefined) {
            return;
        }
        const sessionId = getString(message, 'sessionId');
        const key = getListenerKey(method, sessionId);
        const params = isRecord(message) ? message.params : undefined;
        for (const listener of listeners.get(key) ?? []) {
            listener(params);
        }
    };

    const connection: Connection = {
        send: (method, params, sessionId) => {
            if (closedError) {
                return Promise.reject(closedError);
            }
            const id = nextId;
            nextId += 1;
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    pending.delete(id);
                    const error = new Error(
                        `${method} got no answer within ${COMMAND_TIMEOUT_MS / 1_000}s.`,
                    );
                    reject(error);
                }, COMMAND_TIMEOUT_MS);
                pending.set(id, { method, resolve, reject, timeout });
                const message = JSON.stringify({ id, method, params, sessionId });
                socket.send(message);
            });
        },
        on: (method, sessionId, listener) => {
            const key = getListenerKey(method, sessionId);
            const methodListeners = listeners.get(key) ?? new Set<Listener>();
            methodListeners.add(listener);
            listeners.set(key, methodListeners);
            return () => {
                methodListeners.delete(listener);
            };
        },
        close: () => {
            socket.close();
        },
    };

    return new Promise((resolve, reject) => {
        socket.addEventListener('open', () => resolve(connection));
        socket.addEventListener('error', () => {
            const error = new Error(`The DevTools connection to ${url} failed.`);
            rejectAll(error);
            reject(error);
        });
        socket.addEventListener('close', () => {
            const error = new Error('The DevTools connection closed.');
            rejectAll(error);
        });
        socket.addEventListener('message', (event) => handleMessage(event.data));
    });
};

const createSession = (connection: Connection, sessionId: string | undefined): CdpSession => {
    return {
        send: (method, params = {}) => connection.send(method, params, sessionId),
        on: (method, listener) => connection.on(method, sessionId, listener),
        waitFor: (method, timeoutMs) =>
            new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    removeListener();
                    const error = new Error(
                        `${method} didn't happen within ${timeoutMs / 1_000}s.`,
                    );
                    reject(error);
                }, timeoutMs);
                const removeListener = connection.on(method, sessionId, (params) => {
                    clearTimeout(timeout);
                    removeListener();
                    resolve(params);
                });
            }),
    };
};

const waitForExit = (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), timeoutMs);
        child.once('exit', () => {
            clearTimeout(timeout);
            resolve(true);
        });
    });
};

// Starts Chrome with a throwaway profile on disk, so it keeps an HTTP cache and
// V8's code cache like a returning visitor's browser.
export const launchChrome = async ({
    chromePath,
    flags,
}: {
    chromePath: string;
    flags: string[];
}): Promise<Chrome> => {
    const tmpDirectory = os.tmpdir();
    const profilePrefix = path.join(tmpDirectory, 'build-plugins-canary-chrome-');
    const userDataDirectory = await mkdtemp(profilePrefix);
    const chromeFlags = getChromeFlags(userDataDirectory, flags);
    const child = spawn(chromePath, chromeFlags, { stdio: ['ignore', 'ignore', 'pipe'] });
    // Chrome must not outlive the process that started it.
    const killChrome = (): void => {
        child.kill('SIGKILL');
    };
    process.once('exit', killChrome);

    // Keeps reading stderr, so Chrome never blocks on a full pipe.
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_LENGTH);
    });

    const removeProfile = async (): Promise<void> => {
        await rm(userDataDirectory, { force: true, maxRetries: 3, recursive: true });
    };
    const stop = async (): Promise<void> => {
        const exited = await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
        if (!exited) {
            killChrome();
            await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
        }
        process.off('exit', killChrome);
        await removeProfile();
    };

    let connection: Connection | undefined;
    try {
        const url = await readDevToolsUrl(child, () => stderr);
        connection = await connect(url);
        const browser = createSession(connection, undefined);
        const versionResult = await browser.send('Browser.getVersion');
        const version = getRequiredString(versionResult, 'product', 'Browser.getVersion');
        const openConnection = connection;

        return {
            version,
            newPage: async () => {
                const created = await browser.send('Target.createTarget', { url: 'about:blank' });
                const targetId = getRequiredString(created, 'targetId', 'Target.createTarget');
                const attached = await browser.send('Target.attachToTarget', {
                    flatten: true,
                    targetId,
                });
                const sessionId = getRequiredString(attached, 'sessionId', 'Target.attachToTarget');
                const session = createSession(openConnection, sessionId);
                return {
                    ...session,
                    close: async () => {
                        await browser.send('Target.closeTarget', { targetId });
                    },
                };
            },
            close: async () => {
                try {
                    await browser.send('Browser.close');
                } catch {
                    // Chrome can close the connection before it answers; stop() kills
                    // it if it doesn't exit.
                }
                openConnection.close();
                await stop();
            },
        };
    } catch (error) {
        connection?.close();
        killChrome();
        await stop();
        throw error;
    }
};
