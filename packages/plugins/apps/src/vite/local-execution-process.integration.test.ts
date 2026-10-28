// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getVitePlugin } from '@dd/apps-plugin/vite/index';
import { getContextMock, getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import fs from 'fs';
import http from 'http';
import { type ChildProcess, fork } from 'node:child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
    build,
    createServer,
    defaultServerConditions,
    type HotPayload,
    type Plugin,
    type ViteDevServer,
} from 'vite';

import type { BackendFunction } from '../backend/types';
import { LOCAL_EXECUTION_LOAD_SUFFIX } from '../constants';

import {
    buildLocalExecutionChild,
    FIXTURE_ROOT,
    previewRuntimeContext,
    removeLocalExecutionChild,
} from './local-execution-process.fixtures';
import {
    CHILD_MAX_OLD_SPACE_MB,
    createChildProcessExecutor,
    killLocalExecutionChildren,
    type ChildProcessExecutorOptions,
    type LocalExecutionRequest,
    type OutputStream,
    resolveViteModuleRunner,
} from './local-execution-process';
import type { ChildStartConfig } from './local-execution-protocol';
import { isIndexableRecord } from './local-execution-shared';
import {
    DEFAULT_LONG_POLLING_CONFIG,
    deriveActionTimeouts,
    type ExecuteAction,
    withTimeout,
} from './local-execution';
import { FS_WRITE_BLOCKED_MESSAGE } from './network-guard';

// Spying on the shared core module fails once a sandbox guard makes `fork` non-configurable.
jest.mock('node:child_process', () => {
    const actual = jest.requireActual<typeof import('node:child_process')>('node:child_process');
    return { ...actual, fork: jest.fn(actual.fork) };
});

const CALL_TIMEOUT_MS = 60_000;

const fixtureFunction = (
    file: string,
    name: string,
    allowedConnectionIds: string[] = [],
): BackendFunction => ({
    relativePath: file,
    name,
    absolutePath: path.join(FIXTURE_ROOT, `${file}.backend.ts`),
    allowedConnectionIds,
});

type TimedCall = { calls: number; pid: number; startedAt: number; endedAt: number };

const isTimedCall = (value: unknown): value is TimedCall =>
    typeof value === 'object' &&
    value !== null &&
    'calls' in value &&
    'pid' in value &&
    'startedAt' in value &&
    'endedAt' in value &&
    typeof value.calls === 'number' &&
    typeof value.pid === 'number' &&
    typeof value.startedAt === 'number' &&
    typeof value.endedAt === 'number';

const isProcessAlive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

// A killed child stays visible to `kill(pid, 0)` until it's reaped, which can lag on a busy machine.
const waitUntilGone = async (pid: number, deadline = Date.now() + 5000): Promise<boolean> => {
    if (!isProcessAlive(pid)) {
        return true;
    }
    if (Date.now() > deadline) {
        return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return waitUntilGone(pid, deadline);
};

const childPidFrom = (debugLines: string[]) => {
    const match = debugLines.join('\n').match(/\(pid (\d+),/);
    if (!match) {
        throw new Error(`No child pid logged in: ${debugLines.join('\n')}`);
    }
    return Number(match[1]);
};

const VIRTUAL_MODULE_ID = 'virtual:dd-child-test';
// Some plugins give a virtual module an id that looks like a path, with nothing on disk there.
const SLASH_VIRTUAL_MODULE_ID = '/~dd-child-test-virtual.js';
const virtualModulePlugin: Plugin = {
    name: 'dd-child-test-virtual',
    resolveId: (id) => {
        if (id === VIRTUAL_MODULE_ID) {
            return `\0${VIRTUAL_MODULE_ID}`;
        }
        return id === SLASH_VIRTUAL_MODULE_ID ? id : null;
    },
    load: (id) => {
        if (id === `\0${VIRTUAL_MODULE_ID}`) {
            return 'export const virtualValue = 42;';
        }
        return id === SLASH_VIRTUAL_MODULE_ID ? 'export const slashValue = 7;' : null;
    },
};

describe('Local execution in a child process', () => {
    let server: ViteDevServer;
    let childEntryPath: string;
    let moduleRunnerPath: string;

    beforeAll(async () => {
        childEntryPath = await buildLocalExecutionChild();
        const resolvedRunner = resolveViteModuleRunner(FIXTURE_ROOT);
        if (!resolvedRunner) {
            throw new Error('Expected the fixture to resolve Vite');
        }
        moduleRunnerPath = resolvedRunner;
        const appsPlugin: Plugin = {
            name: 'dd-apps-test',
            ...getVitePlugin({
                bundler: { build, defaultServerConditions },
                context: getContextMock({ buildRoot: FIXTURE_ROOT }),
                options: { include: [], tags: [], longPolling: DEFAULT_LONG_POLLING_CONFIG },
            }),
        };
        server = await createServer({
            configFile: false,
            root: FIXTURE_ROOT,
            logLevel: 'silent',
            server: { middlewareMode: true, hmr: false },
            plugins: [appsPlugin, virtualModulePlugin],
            optimizeDeps: { noDiscovery: true },
        });
    }, CALL_TIMEOUT_MS);

    afterAll(async () => {
        await server?.close();
        removeLocalExecutionChild();
    });

    const makeExecutor = (overrides: Partial<ChildProcessExecutorOptions> = {}) =>
        createChildProcessExecutor({
            invokeChannel: server.environments.ssr.hot,
            projectRoot: FIXTURE_ROOT,
            childEntryPath,
            moduleRunnerPath,
            log: getMockLogger(),
            writeOutput: () => {},
            ...overrides,
        });

    const makeRequest = (
        func: BackendFunction,
        args: unknown[],
        overrides: Partial<LocalExecutionRequest> = {},
    ): LocalExecutionRequest => ({
        func,
        args,
        executeAction: async () => ({ unused: true }),
        getRuntimeContext: async () => previewRuntimeContext,
        getAllowedConnectionIds: async () => func.allowedConnectionIds,
        timeoutMs: 10_000,
        longPolling: DEFAULT_LONG_POLLING_CONFIG,
        ...overrides,
    });

    describe('Isolation', () => {
        const countCalls = fixtureFunction('childState', 'countCalls');

        test(
            'Should start each call with fresh module state and globals',
            async () => {
                const execute = makeExecutor();
                const results: unknown[] = [];
                for (let i = 0; i < 3; i++) {
                    // eslint-disable-next-line no-await-in-loop
                    results.push((await execute(makeRequest(countCalls, [0]))).data);
                }
                expect(results).toEqual([
                    expect.objectContaining({ calls: 1, globalCalls: 1 }),
                    expect.objectContaining({ calls: 1, globalCalls: 1 }),
                    expect.objectContaining({ calls: 1, globalCalls: 1 }),
                ]);
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should run concurrent calls one at a time, each in its own fresh process',
            async () => {
                const execute = makeExecutor();
                const results = await Promise.all(
                    [1, 2, 3].map(() => execute(makeRequest(countCalls, [300]))),
                );

                const data = results.map((r) => r.data).filter(isTimedCall);
                expect(data).toHaveLength(3);
                expect(data.map((d) => d.calls)).toEqual([1, 1, 1]);
                expect(new Set(data.map((d) => d.pid)).size).toBe(3);
                const byStart = [...data].sort((a, b) => a.startedAt - b.startedAt);
                const overlapping = byStart.filter(
                    (d, i) => i > 0 && d.startedAt < byStart[i - 1].endedAt,
                );
                expect(overlapping).toEqual([]);
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should run each call in its own temp dir, so a .env in the project is not picked up from the working directory',
            async () => {
                const execute = makeExecutor();
                const result = await execute(
                    makeRequest(fixtureFunction('childState', 'readWorkingDirectory'), []),
                );
                expect(result.data).toEqual({
                    cwd: expect.stringContaining('dd-apps-exec-'),
                    cwdIsTmpdir: true,
                });
            },
            CALL_TIMEOUT_MS,
        );

        test(
            "Should strip the developer environment, keys included, and keep Node's own runtime settings",
            async () => {
                const previous = {
                    api: process.env.DD_API_KEY,
                    app: process.env.DD_APP_KEY,
                    tz: process.env.TZ,
                };
                process.env.DD_API_KEY = 'parent-api-key';
                process.env.DD_APP_KEY = 'parent-app-key';
                process.env.TZ = 'UTC';
                try {
                    const execute = makeExecutor();
                    const result = await execute(
                        makeRequest(fixtureFunction('childState', 'readEnvNames'), []),
                    );
                    const allNames = Array.isArray(result.data) ? result.data : [];
                    const allowed = [
                        'TMPDIR',
                        'TZ',
                        'NODE_EXTRA_CA_CERTS',
                        'SSL_CERT_FILE',
                        'SSL_CERT_DIR',
                        'SystemRoot',
                        'TEMP',
                        'TMP',
                        // macOS adds this one to every process it starts.
                        '__CF_USER_TEXT_ENCODING',
                    ];
                    expect(allNames.filter((name) => !allowed.includes(name))).toEqual([]);
                    expect(allNames).toEqual(expect.arrayContaining(['TMPDIR', 'TZ']));
                } finally {
                    const restore = (name: string, value: string | undefined) => {
                        if (value === undefined) {
                            delete process.env[name];
                        } else {
                            process.env[name] = value;
                        }
                    };
                    restore('DD_API_KEY', previous.api);
                    restore('DD_APP_KEY', previous.app);
                    restore('TZ', previous.tz);
                }
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should show top-level code an undefined $, as production does, and the call the real one',
            async () => {
                const execute = makeExecutor();
                const result = await execute(
                    makeRequest(fixtureFunction('childLoadTime', 'readDollarAtLoad'), []),
                );
                expect(result.data).toEqual({ dollarAtLoad: 'undefined', dollarAtCall: 'object' });
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should run a nested backend import and an SDK-backed $.Source read for real',
            async () => {
                const execute = makeExecutor();
                const viaHelper = await execute(
                    makeRequest(fixtureFunction('viaHelper', 'usesHelper'), ['via-helper']),
                );
                const runtimeUsers = await execute(
                    makeRequest(fixtureFunction('getRuntimeUsers', 'getRuntimeUsers'), ['label']),
                );
                expect(viaHelper.data).toEqual({ value: 'via-helper' });
                expect(runtimeUsers.data).toEqual({
                    label: 'label',
                    executionUser: previewRuntimeContext.Source.runAsUser,
                    initiatingUser: previewRuntimeContext.Source.initiator,
                });
            },
            CALL_TIMEOUT_MS,
        );
    });

    describe('Limits', () => {
        test.each([
            {
                description: 'a call that never settles',
                name: 'waitForever',
            },
            {
                description: 'a synchronous infinite loop',
                name: 'spinForever',
            },
        ])(
            'Should kill the child of $description once it times out',
            async ({ name }) => {
                const debugLines: string[] = [];
                const execute = makeExecutor({
                    log: getMockLogger({ debug: (text: string) => debugLines.push(text) }),
                });
                const start = Date.now();
                await expect(
                    execute(
                        makeRequest(fixtureFunction('childState', name), [], { timeoutMs: 3000 }),
                    ),
                ).rejects.toThrow(`Local execution of "${name}" timed out after 3000ms`);
                expect(Date.now() - start).toBeLessThan(10_000);
                const pid = childPidFrom(debugLines);
                const gone = await waitUntilGone(pid);
                expect(gone).toBe(true);
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should give loading its own time budget before the call starts its own',
            async () => {
                const execute = makeExecutor();
                const slowLoad = fixtureFunction('childSlowLoad', 'runAfterSlowLoad');
                await expect(
                    execute(makeRequest(slowLoad, [0], { timeoutMs: 400 })),
                ).rejects.toThrow('Loading "childSlowLoad/runAfterSlowLoad" timed out after 400ms');
                // 1200ms to load plus 4000ms to run passes a 5000ms budget only when each gets its own.
                await expect(
                    execute(makeRequest(slowLoad, [4000], { timeoutMs: 5000 })),
                ).resolves.toEqual({ data: 'done' });
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should return a result even when the call replaced process.stdout.write, without waiting out the flush timeout',
            async () => {
                // Long enough that waiting it out would fail the test.
                const execute = makeExecutor({ flushTimeoutMs: CALL_TIMEOUT_MS * 2 });
                await expect(
                    execute(makeRequest(fixtureFunction('childState', 'silenceStdout'), [])),
                ).resolves.toEqual({ data: 'quiet' });
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should not count a $.Actions call started during loading against the call budget',
            async () => {
                const execute = makeExecutor();
                const executeAction: ExecuteAction = async (_fqn, inputs) => {
                    await new Promise((resolve) => setTimeout(resolve, 4000));
                    return inputs;
                };
                await expect(
                    execute(
                        makeRequest(fixtureFunction('childLoadTime', 'awaitEarlyAction'), [], {
                            executeAction,
                            timeoutMs: 3000,
                        }),
                    ),
                ).resolves.toEqual({ data: { early: true } });
            },
            CALL_TIMEOUT_MS,
        );

        test(
            "Should kill every call's process and remove its temp dir when the dev server exits",
            async () => {
                const debugLines: string[] = [];
                const execute = makeExecutor({
                    log: getMockLogger({ debug: (text: string) => debugLines.push(text) }),
                });
                const call = execute(
                    makeRequest(fixtureFunction('childState', 'spinForever'), [], {
                        timeoutMs: 30_000,
                    }),
                );
                while (!debugLines.some((line) => line.includes('(pid '))) {
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }

                const tmpDir = debugLines.join('\n').match(/temp dir ([^)]+)\)/)?.[1];
                expect(tmpDir && fs.existsSync(tmpDir)).toBe(true);

                killLocalExecutionChildren();

                expect(tmpDir && fs.existsSync(tmpDir)).toBe(false);

                await expect(call).rejects.toThrow(
                    'Local execution of "spinForever" ended before returning a result (signal SIGKILL)',
                );
            },
            CALL_TIMEOUT_MS,
        );

        const childErrorCases = [
            {
                description: 'still kill a started process whose kill failed',
                spawnOptions: {},
                expectedKills: ['SIGKILL', 'SIGKILL'],
            },
            {
                description: 'stop tracking a process that never started',
                spawnOptions: { execPath: path.join(os.tmpdir(), 'dd-apps-missing-node') },
                expectedKills: ['SIGKILL'],
            },
        ];
        test.each(childErrorCases)(
            "Should $description when its process emits 'error'",
            async ({ spawnOptions, expectedKills }) => {
                const { fork: realFork } =
                    jest.requireActual<typeof import('node:child_process')>('node:child_process');
                const kills: unknown[] = [];
                let spawned: ChildProcess | undefined;
                jest.mocked(fork).mockImplementationOnce((modulePath, forkArgs, forkOptions) => {
                    const child = realFork(modulePath, forkArgs, {
                        ...forkOptions,
                        ...spawnOptions,
                    });
                    Object.defineProperty(child, 'kill', {
                        value: (signal: unknown) => {
                            kills.push(signal);
                            return false;
                        },
                    });
                    spawned = child;
                    return child;
                });
                const execute = makeExecutor();
                const call = execute(
                    makeRequest(fixtureFunction('childState', 'waitForever'), [], {
                        timeoutMs: 30_000,
                    }),
                );
                call.catch(() => {});
                while (!spawned) {
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
                const child = spawned;
                try {
                    if (child.pid !== undefined) {
                        const killFailure = new Error('kill EPERM');
                        child.emit('error', killFailure);
                    }
                    await expect(call).rejects.toThrow();

                    killLocalExecutionChildren();

                    expect(kills).toEqual(expectedKills);
                } finally {
                    if (child.pid !== undefined) {
                        process.kill(child.pid, 'SIGKILL');
                    }
                }
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should refuse calls still queued or starting once its executor closes',
            async () => {
                const debugLines: string[] = [];
                const execute = makeExecutor({
                    log: getMockLogger({ debug: (text: string) => debugLines.push(text) }),
                });
                let releaseContext: () => void = () => {};
                const contextHeld = new Promise((resolve) => {
                    releaseContext = () => resolve(previewRuntimeContext);
                });
                let markContextRequested: () => void = () => {};
                const contextRequested = new Promise<void>((resolve) => {
                    markContextRequested = resolve;
                });
                const countCalls = fixtureFunction('childState', 'countCalls');
                const starting = execute(
                    makeRequest(countCalls, [0], {
                        getRuntimeContext: () => {
                            markContextRequested();
                            return contextHeld;
                        },
                    }),
                );
                const queued = execute(
                    makeRequest(countCalls, [0], { getRuntimeContext: () => contextHeld }),
                );
                const settled = Promise.allSettled([starting, queued]);

                // The first call is past its start, waiting on its runtime context, when the server closes.
                await contextRequested;
                execute.close();
                releaseContext();

                const refusal =
                    'Local execution of "countCalls" didn\'t start: its dev server closed';
                const reasons = (await settled).map((result) =>
                    result.status === 'rejected' ? String(result.reason) : 'fulfilled',
                );
                expect(reasons).toEqual([`Error: ${refusal}`, `Error: ${refusal}`]);
                expect(debugLines.filter((line) => line.includes('(pid '))).toEqual([]);
            },
            CALL_TIMEOUT_MS,
        );

        test(
            "Should kill only its own calls' processes when an executor closes",
            async () => {
                const debugLines: string[] = [];
                const execute = makeExecutor({
                    log: getMockLogger({ debug: (text: string) => debugLines.push(text) }),
                });
                const otherExecutor = makeExecutor();
                const call = execute(
                    makeRequest(fixtureFunction('childState', 'spinForever'), [], {
                        timeoutMs: 30_000,
                    }),
                );
                const settled = call.then(
                    () => 'settled',
                    () => 'settled',
                );
                while (!debugLines.some((line) => line.includes('(pid '))) {
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }

                otherExecutor.close();
                const stillPending = new Promise((resolve) => setTimeout(resolve, 500, 'pending'));
                await expect(Promise.race([settled, stillPending])).resolves.toBe('pending');

                execute.close();
                await expect(call).rejects.toThrow(
                    'Local execution of "spinForever" ended before returning a result (signal SIGKILL)',
                );
            },
            CALL_TIMEOUT_MS,
        );

        test(
            "Should end a call's process once its IPC channel to the dev server closes",
            async () => {
                const countCalls = fixtureFunction('childState', 'countCalls');
                const config: ChildStartConfig = {
                    moduleRunnerUrl: pathToFileURL(moduleRunnerPath).href,
                    entryUrl: countCalls.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX,
                    entryPath: countCalls.absolutePath,
                    functionName: countCalls.name,
                    args: [CALL_TIMEOUT_MS],
                    runtimeContext: previewRuntimeContext,
                    actionCatalogInstalled: false,
                    appsBackendInstalled: false,
                    flushTimeoutMs: 1000,
                };
                const child = fork(childEntryPath, [], {
                    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                });
                try {
                    let loaded = false;
                    child.on(
                        'message',
                        async (message: { type: string; id: number; payload: HotPayload }) => {
                            if (message.type === 'invoke') {
                                const response = await server.environments.ssr.hot.handleInvoke(
                                    message.payload,
                                );
                                child.send({ type: 'invoke-result', id: message.id, response });
                                loaded = true;
                            }
                        },
                    );
                    const exited = new Promise((resolve) => child.once('exit', resolve));
                    child.send({ type: 'start', config });
                    while (!loaded) {
                        // eslint-disable-next-line no-await-in-loop
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                    await new Promise((resolve) => setTimeout(resolve, 300));

                    child.disconnect();

                    await expect(withTimeout(exited, 5000, 'Child exit')).resolves.toBe(1);
                } finally {
                    child.kill('SIGKILL');
                }
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should report a call that exits before returning',
            async () => {
                const execute = makeExecutor();
                await expect(
                    execute(makeRequest(fixtureFunction('childState', 'exitEarly'), [])),
                ).rejects.toThrow(
                    'Local execution of "exitEarly" ended before returning a result (exit code 3)',
                );
            },
            CALL_TIMEOUT_MS,
        );

        test(
            "Should report a thrown value that can't be converted to a string, instead of timing out",
            async () => {
                const execute = makeExecutor();
                const func = fixtureFunction('childState', 'throwUnprintable');
                await expect(execute(makeRequest(func, [], { timeoutMs: 3000 }))).rejects.toThrow(
                    "A thrown object that can't be converted to a string",
                );
            },
            CALL_TIMEOUT_MS,
        );

        test(
            `Should report a call that runs past ${CHILD_MAX_OLD_SPACE_MB} MB of heap`,
            async () => {
                const execute = makeExecutor();
                await expect(
                    execute(
                        makeRequest(fixtureFunction('childState', 'allocateUntilOutOfMemory'), [], {
                            timeoutMs: 30_000,
                        }),
                    ),
                ).rejects.toThrow(
                    `Local execution of "allocateUntilOutOfMemory" ran out of memory (${CHILD_MAX_OLD_SPACE_MB} MB)`,
                );
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should not report a call as out of memory because its own output mentions it',
            async () => {
                const execute = makeExecutor({ writeOutput: () => {} });
                await expect(
                    execute(
                        makeRequest(fixtureFunction('childState', 'logOutOfMemoryAndExit'), []),
                    ),
                ).rejects.toThrow(
                    'Local execution of "logOutOfMemoryAndExit" ended before returning a result (exit code 1)',
                );
            },
            CALL_TIMEOUT_MS,
        );
    });

    describe('Guards', () => {
        let fetchServer: http.Server;
        let fetchUrl: string;
        let projectFile: string;
        let sharedTmpFile: string;

        beforeAll(async () => {
            fetchServer = http.createServer((_req, res) => res.end('pong'));
            await new Promise<void>((resolve) => fetchServer.listen(0, '127.0.0.1', resolve));
            const address = fetchServer.address();
            if (!address || typeof address === 'string') {
                throw new Error('Expected the fetch server to listen on a TCP port');
            }
            fetchUrl = `http://127.0.0.1:${address.port}/`;
        });

        beforeEach(() => {
            const probeName = `sandbox-probe-${process.pid}-${Date.now()}.txt`;
            projectFile = path.join(FIXTURE_ROOT, probeName);
            sharedTmpFile = path.join('/tmp', probeName);
        });

        afterEach(() => {
            fs.rmSync(projectFile, { force: true });
            fs.rmSync(sharedTmpFile, { force: true });
            fs.rmSync(path.join(FIXTURE_ROOT, 'top-level-probe.txt'), { force: true });
        });

        afterAll(async () => {
            await new Promise((resolve) => fetchServer.close(resolve));
        });

        test(
            'Should refuse project writes, subprocesses and workers with the in-process guards, and allow temp writes and fetch',
            async () => {
                const execute = makeExecutor();
                const result = await execute(
                    makeRequest(fixtureFunction('childSandbox', 'runSandboxProbes'), [
                        projectFile,
                        fetchUrl,
                        sharedTmpFile,
                    ]),
                );
                expect(result.data).toEqual({
                    sharedTmpWrite: 'ok: written',
                    projectWrite: 'refused: EROFS',
                    tempWrite: 'ok: x',
                    spawn: 'refused: Spawning a subprocess is not allowed in backend functions.',
                    worker: 'refused: Spawning a worker thread is not allowed in backend functions.',
                    fetch: 'ok: 200 pong',
                });
                expect(fs.existsSync(projectFile)).toBe(false);
            },
            CALL_TIMEOUT_MS,
        );

        test(
            "Should guard a module's top-level code too",
            async () => {
                const execute = makeExecutor();
                await expect(
                    execute(
                        makeRequest(
                            fixtureFunction('childTopLevelWrite', 'afterTopLevelWrite'),
                            [],
                        ),
                    ),
                ).rejects.toThrow(FS_WRITE_BLOCKED_MESSAGE);
                expect(fs.existsSync(path.join(FIXTURE_ROOT, 'top-level-probe.txt'))).toBe(false);
            },
            CALL_TIMEOUT_MS,
        );

        test(
            "Should print each call's debugger URL while debugging",
            async () => {
                const lines: string[] = [];
                const execute = makeExecutor({
                    isInspectorActive: () => true,
                    writeOutput: (_stream, line) => lines.push(line),
                });
                await execute(makeRequest(fixtureFunction('childState', 'countCalls'), [0]));
                expect(lines.join('\n')).toContain('Debugger listening on ws://127.0.0.1:');
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should not time out a call while debugging, so a breakpoint can hold it',
            async () => {
                const debugLines: string[] = [];
                const execute = makeExecutor({
                    isInspectorActive: () => true,
                    log: getMockLogger({ debug: (text: string) => debugLines.push(text) }),
                });
                let settled = false;
                const call = execute(
                    makeRequest(fixtureFunction('childState', 'waitForever'), [], {
                        timeoutMs: 300,
                    }),
                ).finally(() => {
                    settled = true;
                });
                call.catch(() => {});
                await new Promise((resolve) => setTimeout(resolve, 1500));
                expect(settled).toBe(false);
                killLocalExecutionChildren();
                await expect(call).rejects.toThrow('ended before returning a result');
                expect(debugLines.join('\n')).toContain('(pid ');
            },
            CALL_TIMEOUT_MS,
        );
    });
    describe('Module loading over IPC', () => {
        const loadOverIpc = fixtureFunction('childSandbox', 'loadOverIpc');

        test(
            "Should load a plugin's virtual module",
            async () => {
                const execute = makeExecutor();
                const result = await execute(
                    makeRequest(fixtureFunction('childVirtual', 'readVirtualModule'), []),
                );
                expect(result.data).toEqual({ virtualValue: 42, slashValue: 7 });
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should load a module inside the project over the same channel',
            async () => {
                const execute = makeExecutor();
                const result = await execute(
                    makeRequest(loadOverIpc, [`${path.join(FIXTURE_ROOT, 'package.json')}?raw`]),
                );
                expect(JSON.stringify(result.data)).toContain('apps_backend_project');
            },
            CALL_TIMEOUT_MS,
        );

        describe('import.meta', () => {
            let runnerDir = '';

            beforeAll(() => {
                const tmpPrefix = path.join(os.tmpdir(), 'dd-apps-fake-runner-');
                runnerDir = fs.mkdtempSync(tmpPrefix);
            });

            afterAll(() => {
                fs.rmSync(runnerDir, { recursive: true, force: true });
            });

            // Vite 7 and 8's module runner resolves import.meta.resolve only through its
            // createImportMeta option; this repo's tests run Vite 6, whose runner has none.
            const FAKE_VITE_7_RUNNER = `
import { pathToFileURL } from 'node:url';
const createDefaultImportMeta = (modulePath) => ({
    url: pathToFileURL(modulePath).href,
    resolve() {
        throw new Error('[module runner] "import.meta.resolve" is not supported.');
    },
});
export const createNodeImportMeta = async (modulePath) => ({
    ...createDefaultImportMeta(modulePath),
    resolve: (specifier) => new URL(specifier, pathToFileURL(modulePath)).href,
});
export class ESModulesEvaluator {}
export class ModuleRunner {
    constructor(options) {
        this.options = options;
    }
    async import(url) {
        const createImportMeta = this.options.createImportMeta ?? createDefaultImportMeta;
        const meta = await createImportMeta(url.split('?')[0]);
        return { resolveSibling: () => meta.resolve('./sibling.js') };
    }
}
`;

            test(
                'Should give a backend function a working import.meta.resolve',
                async () => {
                    const fakeRunnerPath = path.join(runnerDir, 'module-runner.mjs');
                    fs.writeFileSync(fakeRunnerPath, FAKE_VITE_7_RUNNER);
                    const execute = makeExecutor({ moduleRunnerPath: fakeRunnerPath });
                    const func = fixtureFunction('childImportMeta', 'resolveSibling');
                    const result = await execute(makeRequest(func, []));
                    const siblingUrl = String(result.data);
                    expect(fileURLToPath(siblingUrl)).toBe(path.join(FIXTURE_ROOT, 'sibling.js'));
                },
                CALL_TIMEOUT_MS,
            );
        });
    });

    describe('Return values', () => {
        const returning = (name: string) => fixtureFunction('childReturnValues', name);

        test.each([
            { name: 'returnCircular', message: /returnCircular.*can't be serialized to JSON/ },
            { name: 'returnBigInt', message: /returnBigInt.*can't be serialized to JSON/ },
            { name: 'returnFunction', message: /returnFunction.*JSON.stringify silently drops/ },
            { name: 'returnMap', message: /returnMap.*silently flattens/ },
            { name: 'returnNestedSet', message: /returnNestedSet.*silently flattens/ },
            { name: 'returnNestedNaN', message: /returnNestedNaN.*silently converts to "null"/ },
            { name: 'returnInfinity', message: /returnInfinity.*silently converts to "null"/ },
            { name: 'returnSymbolKey', message: /returnSymbolKey.*Symbol-keyed property/ },
            {
                name: 'returnSymbolKeyViaToJson',
                message: /returnSymbolKeyViaToJson.*Symbol-keyed property/,
            },
            {
                name: 'returnSymbolInArray',
                message: /returnSymbolInArray.*symbol inside an array.*silently converts to null/,
            },
            {
                name: 'returnUndefinedInArray',
                message:
                    /returnUndefinedInArray.*undefined inside an array.*silently converts to null/,
            },
        ])(
            'Should reject what $name returns, which JSON would corrupt',
            async ({ name, message }) => {
                const execute = makeExecutor();
                await expect(execute(makeRequest(returning(name), []))).rejects.toThrow(message);
            },
            CALL_TIMEOUT_MS,
        );

        test.each([
            {
                name: 'returnUndefinedProperties',
                data: { status: 'ok' },
            },
            { name: 'returnUndefined', data: undefined },
            { name: 'returnCountingToJson', data: { toJsonCalls: 1 } },
        ])(
            'Should return what $name returns as JSON would send it',
            async ({ name, data }) => {
                const execute = makeExecutor();
                const result = await execute(makeRequest(returning(name), []));
                expect(result).toEqual({ data });
            },
            CALL_TIMEOUT_MS,
        );
    });

    describe('$.Actions', () => {
        const record = () => {
            const calls: Array<{ fqn: string; inputs: unknown; connectionId?: string }> = [];
            const executeAction: ExecuteAction = async (fqn, inputs, connectionId) => {
                calls.push({ fqn, inputs, connectionId });
                return { echoedConnection: connectionId ?? null };
            };
            return { calls, executeAction };
        };

        test(
            'Should dispatch through the dev server with the connection the function is allowed',
            async () => {
                const { calls, executeAction } = record();
                const execute = makeExecutor();
                const func = fixtureFunction('childActions', 'callHttp', ['conn-a']);
                const result = await execute(makeRequest(func, ['conn-a'], { executeAction }));
                expect(result.data).toEqual({ echoedConnection: 'conn-a' });
                expect(calls).toEqual([
                    {
                        fqn: 'com.datadoghq.http.request',
                        inputs: { url: 'https://example.com' },
                        connectionId: 'conn-a',
                    },
                ]);
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should scope each of two overlapping calls to its own allowed connections',
            async () => {
                const { calls, executeAction } = record();
                const execute = makeExecutor();
                const funcA = fixtureFunction('childActions', 'callHttp', ['conn-a']);
                const funcB = { ...fixtureFunction('childActions', 'callHttp', ['conn-b']) };
                const [aOwn, bOwn, aUsingB, bUsingA] = await Promise.allSettled([
                    execute(makeRequest(funcA, ['conn-a', 300], { executeAction })),
                    execute(makeRequest(funcB, ['conn-b', 300], { executeAction })),
                    execute(makeRequest(funcA, ['conn-b', 300], { executeAction })),
                    execute(makeRequest(funcB, ['conn-a', 300], { executeAction })),
                ]);
                expect(aOwn).toEqual({
                    status: 'fulfilled',
                    value: { data: { echoedConnection: 'conn-a' } },
                });
                expect(bOwn).toEqual({
                    status: 'fulfilled',
                    value: { data: { echoedConnection: 'conn-b' } },
                });
                expect(aUsingB).toEqual({
                    status: 'rejected',
                    reason: new Error(
                        `Action $.Actions.http.request used connection "conn-b", which is not in this function's allowed connections: [conn-a]`,
                    ),
                });
                expect(bUsingA).toEqual({
                    status: 'rejected',
                    reason: new Error(
                        `Action $.Actions.http.request used connection "conn-a", which is not in this function's allowed connections: [conn-b]`,
                    ),
                });
                expect(calls.map((c) => c.connectionId).sort()).toEqual(['conn-a', 'conn-b']);
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should refuse a forged IPC action request outside the allowed connections',
            async () => {
                const { calls, executeAction } = record();
                const execute = makeExecutor();
                const func = fixtureFunction('childActions', 'forgeActionMessage', ['conn-a']);
                const result = await execute(makeRequest(func, ['conn-evil'], { executeAction }));
                expect(result.data).toEqual({
                    type: 'action-result',
                    id: 999_999,
                    ok: false,
                    message: `Action forged used connection "conn-evil", which is not in this function's allowed connections: [conn-a]`,
                });
                expect(calls).toEqual([]);
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should answer a malformed IPC action request with an error instead of leaving it hanging',
            async () => {
                const { calls, executeAction } = record();
                const execute = makeExecutor();
                const func = fixtureFunction('childActions', 'forgeActionMessage', ['conn-a']);
                const result = await execute(makeRequest(func, [null], { executeAction }));
                expect(result.data).toEqual({
                    type: 'action-result',
                    id: 999_999,
                    ok: false,
                    message: expect.stringContaining('Malformed $.Actions request'),
                });
                expect(calls).toEqual([]);
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should still time out a call that keeps retrying a refused connection',
            async () => {
                const execute = makeExecutor();
                const func = fixtureFunction('childActions', 'retryRefusedConnection', ['conn-a']);
                await expect(execute(makeRequest(func, [], { timeoutMs: 2000 }))).rejects.toThrow(
                    'Local execution of "retryRefusedConnection" timed out after 2000ms',
                );
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should end a call at the absolute ceiling while its $.Actions call is still in flight',
            async () => {
                const longPolling = {
                    ...DEFAULT_LONG_POLLING_CONFIG,
                    maxRetries: 1,
                    timeoutMs: 1000,
                };
                const { totalExecutionTimeoutMs } = deriveActionTimeouts(longPolling);
                const execute = makeExecutor();
                const neverSettles: ExecuteAction = () => new Promise(() => {});
                const func = fixtureFunction('childActions', 'callHttp');
                await expect(
                    execute(makeRequest(func, [], { executeAction: neverSettles, longPolling })),
                ).rejects.toThrow(
                    `Local execution of "callHttp" exceeded the ${totalExecutionTimeoutMs}ms execution ceiling since its module loaded or its latest $.Actions call started.`,
                );
            },
            CALL_TIMEOUT_MS,
        );

        test(
            "Should fail with an action's error it can't send back to the call, instead of timing out",
            async () => {
                const { fork: realFork } =
                    jest.requireActual<typeof import('node:child_process')>('node:child_process');
                const forkMock = jest.mocked(fork);
                forkMock.mockImplementation((modulePath, forkArgs, forkOptions) => {
                    const child = realFork(modulePath, forkArgs, forkOptions);
                    const relay = child.send.bind(child);
                    Object.defineProperty(child, 'send', {
                        value: (message: unknown, callback: unknown) => {
                            const isActionFailure =
                                isIndexableRecord(message) &&
                                message.type === 'action-result' &&
                                message.ok === false;
                            if (isActionFailure) {
                                throw new Error('IPC write failed');
                            }
                            return Reflect.apply(relay, child, [message, callback]);
                        },
                    });
                    return child;
                });
                const failingAction: ExecuteAction = async () => {
                    throw new Error('Slack said no');
                };
                const execute = makeExecutor();
                const func = fixtureFunction('childActions', 'callHttp');
                try {
                    await expect(
                        execute(
                            makeRequest(func, [], {
                                executeAction: failingAction,
                                timeoutMs: 3000,
                            }),
                        ),
                    ).rejects.toThrow('Slack said no');
                } finally {
                    forkMock.mockImplementation(realFork);
                }
            },
            CALL_TIMEOUT_MS,
        );

        test.each([
            {
                reply: "an action's error",
                isDropped: (message: Record<string, unknown>) =>
                    message.type === 'action-result' && message.ok === false,
                expected: 'Slack said no',
            },
            {
                reply: 'a module load',
                isDropped: (message: Record<string, unknown>) => message.type === 'invoke-result',
                expected: `Couldn't reply to "callHttp"'s child process: IPC write failed`,
            },
        ])(
            'Should fail when sending $reply back to the call reports an error, instead of timing out',
            async ({ isDropped, expected }) => {
                const { fork: realFork } =
                    jest.requireActual<typeof import('node:child_process')>('node:child_process');
                const forkMock = jest.mocked(fork);
                forkMock.mockImplementation((modulePath, forkArgs, forkOptions) => {
                    const child = realFork(modulePath, forkArgs, forkOptions);
                    const relay = child.send.bind(child);
                    Object.defineProperty(child, 'send', {
                        value: (message: unknown, callback: unknown) => {
                            if (
                                isIndexableRecord(message) &&
                                isDropped(message) &&
                                typeof callback === 'function'
                            ) {
                                setImmediate(() => callback(new Error('IPC write failed')));
                                return true;
                            }
                            return Reflect.apply(relay, child, [message, callback]);
                        },
                    });
                    return child;
                });
                const failingAction: ExecuteAction = async () => {
                    throw new Error('Slack said no');
                };
                const execute = makeExecutor();
                const func = fixtureFunction('childActions', 'callHttp');
                try {
                    await expect(
                        execute(
                            makeRequest(func, [], {
                                executeAction: failingAction,
                                timeoutMs: 3000,
                            }),
                        ),
                    ).rejects.toThrow(expected);
                } finally {
                    forkMock.mockImplementation(realFork);
                }
            },
            CALL_TIMEOUT_MS,
        );

        test.each([
            { reply: 'is sent after the result', isSentLate: true },
            { reply: 'was sent before the result', isSentLate: false },
        ])(
            'Should return a result when replying to an action it left running fails, if the reply $reply',
            async ({ isSentLate }) => {
                const { fork: realFork } =
                    jest.requireActual<typeof import('node:child_process')>('node:child_process');
                const forkMock = jest.mocked(fork);
                let hasReturned = false;
                let markReturned = () => {};
                const returned = new Promise<void>((resolve) => {
                    markReturned = () => {
                        hasReturned = true;
                        resolve();
                    };
                });
                forkMock.mockImplementation((modulePath, forkArgs, forkOptions) => {
                    const child = realFork(modulePath, forkArgs, forkOptions);
                    child.on('message', (message: unknown) => {
                        if (isIndexableRecord(message) && message.type === 'result') {
                            markReturned();
                        }
                    });
                    const relay = child.send.bind(child);
                    Object.defineProperty(child, 'send', {
                        value: (message: unknown, callback: unknown) => {
                            const isActionReply =
                                isIndexableRecord(message) && message.type === 'action-result';
                            if (isActionReply && hasReturned) {
                                throw new Error('IPC write failed');
                            }
                            if (isActionReply && typeof callback === 'function') {
                                const failWrite = () => callback(new Error('IPC write failed'));
                                returned.then(() => setImmediate(failWrite));
                                return true;
                            }
                            return Reflect.apply(relay, child, [message, callback]);
                        },
                    });
                    return child;
                });
                const leftRunning: ExecuteAction = async () => {
                    if (isSentLate) {
                        await returned;
                    }
                    return { late: true };
                };
                const execute = makeExecutor();
                const func = fixtureFunction('childActions', 'callHttpWithoutAwaiting');
                try {
                    await expect(
                        execute(makeRequest(func, [], { executeAction: leftRunning })),
                    ).resolves.toEqual({ data: 'returned' });
                } finally {
                    forkMock.mockImplementation(realFork);
                }
            },
            CALL_TIMEOUT_MS,
        );

        test(
            'Should run a typed action-catalog call through the same scope check',
            async () => {
                const { calls, executeAction } = record();
                const execute = makeExecutor();
                const allowed = fixtureFunction('actionCatalogCall', 'postMessage', ['conn-1']);
                const disallowed = fixtureFunction('actionCatalogCall', 'postMessage', []);
                await expect(execute(makeRequest(allowed, [], { executeAction }))).resolves.toEqual(
                    { data: { echoedConnection: 'conn-1' } },
                );
                await expect(
                    execute(makeRequest(disallowed, [], { executeAction })),
                ).rejects.toThrow(
                    `Action "com.datadoghq.slack.chat.postMessage" used connection "conn-1", which is not in this function's allowed connections: []`,
                );
                expect(calls).toEqual([
                    {
                        fqn: 'com.datadoghq.slack.chat.postMessage',
                        inputs: { text: 'hi' },
                        connectionId: 'conn-1',
                    },
                ]);
            },
            CALL_TIMEOUT_MS,
        );

        test.each([
            {
                name: 'callHttpWithMap',
                message:
                    'Inputs to action $.Actions.http.request contains a Map (at "headers"), which JSON.stringify silently flattens to "{}" instead of serializing its entries — use a plain array or object instead.',
            },
            {
                name: 'callHttpDeclaringScope',
                message:
                    "Action $.Actions.http.request must not declare its own allowedConnectionIds in inputs — this function's own allowlist already governs which connections it can use.",
            },
            {
                name: 'callHttpDeclaringScopeViaToJson',
                message:
                    "Action $.Actions.http.request must not declare its own allowedConnectionIds in inputs — this function's own allowlist already governs which connections it can use.",
            },
            {
                name: 'callHttpWithTopLevelToJson',
                message:
                    'must be a plain object after JSON round-tripping, but a custom toJSON() changed its top-level shape to string',
            },
        ])(
            'Should reject $name in the child before it reaches the dev server',
            async ({ name, message }) => {
                const { calls, executeAction } = record();
                const execute = makeExecutor();
                await expect(
                    execute(
                        makeRequest(fixtureFunction('childActions', name), [], { executeAction }),
                    ),
                ).rejects.toThrow(message);
                expect(calls).toEqual([]);
            },
            CALL_TIMEOUT_MS,
        );
    });

    describe('Logs', () => {
        test(
            'Should stream each line as it is written, not after the call ends',
            async () => {
                const lines: Array<{ stream: OutputStream; line: string; at: number }> = [];
                const execute = makeExecutor({
                    writeOutput: (stream, line) => lines.push({ stream, line, at: Date.now() }),
                });
                const delayMs = 800;
                await execute(makeRequest(fixtureFunction('childState', 'countCalls'), [0]));
                const result = await execute(
                    makeRequest(fixtureFunction('childState', 'logLines'), [delayMs]),
                );
                const endedAt = Date.now();

                expect(result.data).toBe('logged');
                expect(lines.map(({ stream, line }) => ({ stream, line }))).toEqual([
                    { stream: 'stdout', line: 'first line' },
                    { stream: 'stderr', line: 'second line' },
                    { stream: 'stdout', line: 'no trailing newline' },
                ]);
                expect(endedAt - lines[0].at).toBeGreaterThanOrEqual(delayMs * 0.75);
            },
            CALL_TIMEOUT_MS,
        );
    });
});
