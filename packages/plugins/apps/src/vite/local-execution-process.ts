// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/** Runs each local backend function call in a fresh, sandboxed Node child process, the way production gives each call its own process. */

import { readJsonSync, rm, rmSync } from '@dd/core/helpers/fs';
import type { Logger } from '@dd/core/types';
import { type ChildProcess, fork } from 'node:child_process';
import fs from 'node:fs';
import inspector from 'node:inspector';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import type { HotPayload } from 'vite';

import { isActionCatalogInstalled, isDatadogAppsBackendInstalled } from '../backend/shared';
import type { BackendFunction, BackendOutputs } from '../backend/types';
import { LOCAL_EXECUTION_LOAD_SUFFIX } from '../constants';
import type { LongPollingOptions } from '../types';

import type { ChildStartConfig, ParentMessage } from './local-execution-protocol';
import {
    collectReadPaths,
    createModuleLoadGuard,
    permissionModelArgv,
    sharedTmpPaths,
    withRealPath,
} from './local-execution-sandbox';
import {
    FunctionThrewError,
    isIndexableRecord,
    validateActionCall,
} from './local-execution-shared';
import type { ExecuteAction, GetRuntimeContext } from './local-execution';
import {
    assertValidRuntimeContext,
    deriveActionTimeouts,
    localExecutionResolutionContext,
    withTimeout,
} from './local-execution';

const DEFAULT_FLUSH_TIMEOUT_MS = 1000;
/** Approximates production's 256 MiB per call. */
export const CHILD_MAX_OLD_SPACE_MB = 256;

/** The dev server side of Vite's module runner transport: `server.environments.ssr.hot`. */
export interface InvokeChannel {
    handleInvoke(payload: HotPayload): Promise<unknown>;
}

export type OutputStream = 'stdout' | 'stderr';

export interface LocalExecutionRequest {
    func: BackendFunction;
    args: unknown[];
    executeAction: ExecuteAction;
    getRuntimeContext: GetRuntimeContext;
    getAllowedConnectionIds: (entryId: string) => Promise<string[]>;
    timeoutMs: number;
    longPolling: Required<LongPollingOptions>;
}

export type LocalExecutor = (request: LocalExecutionRequest) => Promise<BackendOutputs>;
/** `close` ends this executor's calls, for when its dev server closes or restarts. */
export type ChildProcessExecutor = LocalExecutor & { close: () => void };

export interface ChildProcessExecutorOptions {
    invokeChannel: InvokeChannel;
    projectRoot: string;
    childEntryPath: string;
    moduleRunnerPath: string;
    /** Extra folders a call may read, such as Vite's `server.fs.allow`, which covers a monorepo's packages. */
    readRoots: string[];
    /** Vite's `server.fs.deny` globs, which no module load may read. */
    denyPatterns: string[];
    /** False when Vite's `server.fs.strict` is off, so module loads aren't limited to the readable folders. */
    restrictModuleLoads: boolean;
    /** Vite's SSR resolver, which tells which file a module request would read before Vite reads it. */
    resolveModule: (url: string, importer: string | undefined) => Promise<string | undefined>;
    log: Logger;
    writeOutput?: (stream: OutputStream, line: string) => void;
    nodeFlags?: ReadonlySet<string>;
    isInspectorActive?: () => boolean;
    /** How long a finished call waits for its output to flush before returning anyway. */
    flushTimeoutMs?: number;
}

const INVOKE_NAMES = new Set(['fetchModule', 'getBuiltins']);

type ChildTmpDirs = Map<ChildProcess, string>;

const liveChildren: ChildTmpDirs = new Map();
let killsChildrenOnExit = false;

function killChildren(children: ChildTmpDirs): void {
    children.forEach((_tmpDir, child) => child.kill('SIGKILL'));
    children.forEach((tmpDir) => {
        try {
            rmSync(tmpDir);
        } catch {
            // Best effort while the dev server exits; the OS cleans its temp dir eventually.
        }
    });
}

export function killLocalExecutionChildren(): void {
    killChildren(liveChildren);
}

// A child stuck in a synchronous loop never sees its IPC channel close when the dev server exits.
function trackChild(child: ChildProcess, tmpDir: string, ownChildren: ChildTmpDirs): void {
    liveChildren.set(child, tmpDir);
    ownChildren.set(child, tmpDir);
    const untrack = () => {
        liveChildren.delete(child);
        ownChildren.delete(child);
    };
    child.once('close', untrack);
    child.once('error', untrack);
    if (!killsChildrenOnExit) {
        killsChildrenOnExit = true;
        process.once('exit', killLocalExecutionChildren);
    }
}

const writeToTerminal = (stream: OutputStream, line: string) => {
    process[stream].write(`${line}\n`);
};

const isDebuggerAttached = () => inspector.url() !== undefined;

// V8's own fatal error line, so a call's output that mentions memory isn't mistaken for it.
const V8_OUT_OF_MEMORY_LINE = /^FATAL ERROR: .*heap out of memory/;

export const MODULE_RUNNER_UNRESOLVED_WARNING =
    "Couldn't use vite/module-runner from the project, which needs Vite 6.0.4 or later, so backend functions run inside the dev server's process, one at a time, instead of each in a fresh process.";

export const YARN_PNP_WARNING =
    "Backend functions in a Yarn Plug'n'Play project run inside the dev server's process, one at a time, instead of each in a fresh process.";

/** Yarn Plug'n'Play resolves packages through hooks the dev server loads from `NODE_OPTIONS`, which a call's process doesn't get. */
export function isYarnPnpRuntime(): boolean {
    return process.versions.pnp !== undefined;
}

// Vite 6.0.0 to 6.0.3 answer the module runner as { r } and { e }, not { result } and { error }.
function repliesInCurrentShape(version: unknown): boolean {
    const match = typeof version === 'string' ? /^(\d+)\.(\d+)\.(\d+)(-)?/.exec(version) : null;
    if (!match) {
        return false;
    }
    const [major, minor, patch] = match.slice(1, 4).map(Number);
    if (major !== 6 || minor !== 0) {
        return major > 6 || (major === 6 && minor > 0);
    }
    return patch > 4 || (patch === 4 && match[4] === undefined);
}

/** Vite's module runner from the project's own Vite, which serves it modules over `handleInvoke`. */
export function resolveViteModuleRunner(projectRoot: string): string | undefined {
    try {
        const projectPackageJson = path.join(projectRoot, 'package.json');
        const projectRequire = createRequire(projectPackageJson);
        const vitePackageJson = projectRequire.resolve('vite/package.json');
        const { exports, version } = readJsonSync(vitePackageJson);
        if (!repliesInCurrentShape(version)) {
            return undefined;
        }
        const entry: unknown = isIndexableRecord(exports) ? exports['./module-runner'] : undefined;
        const importEntry = isIndexableRecord(entry) ? entry.import ?? entry.default : entry;
        const target = isIndexableRecord(importEntry) ? importEntry.default : importEntry;
        const viteDir = path.dirname(vitePackageJson);
        return typeof target === 'string' ? path.join(viteDir, target) : undefined;
    } catch {
        return undefined;
    }
}

// Node's own TLS and time zone settings, which a corporate proxy or a test may need; never app keys.
const NODE_RUNTIME_ENV = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'TZ'];

/** Production gives each call a fresh environment without the developer's variables or keys. */
function buildChildEnv(tmpDir: string): typeof process.env {
    const env: typeof process.env = { TMPDIR: tmpDir };
    for (const name of NODE_RUNTIME_ENV) {
        if (process.env[name] !== undefined) {
            env[name] = process.env[name];
        }
    }
    if (process.platform === 'win32') {
        env.TEMP = tmpDir;
        env.TMP = tmpDir;
        env.SystemRoot = process.env.SystemRoot;
    }
    return env;
}

const LINE_BREAK = /\r\n|\n|\r(?!$)/;

export function forwardLines(stream: Readable, onLine: (line: string) => void): void {
    const decoder = new StringDecoder('utf8');
    let partial = '';
    const take = (text: string) => {
        const lines = (partial + text).split(LINE_BREAK);
        partial = lines.pop() ?? '';
        for (const line of lines) {
            onLine(line);
        }
    };
    stream.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        take(text);
    });
    stream.on('end', () => {
        const rest = decoder.end();
        take(rest);
        const lastLine = partial.endsWith('\r') ? partial.slice(0, -1) : partial;
        if (lastLine) {
            onLine(lastLine);
        }
    });
}

interface InvokeRequest {
    invokeId: string;
    name: string;
    args: unknown[];
}

function invokeRequest(message: Record<string, unknown>): InvokeRequest | undefined {
    const { payload } = message;
    if (!isIndexableRecord(payload) || !isIndexableRecord(payload.data)) {
        return undefined;
    }
    const { id: invokeId, name, data } = payload.data;
    const isValid =
        typeof invokeId === 'string' &&
        typeof name === 'string' &&
        INVOKE_NAMES.has(name) &&
        Array.isArray(data);
    return isValid ? { invokeId, name, args: data } : undefined;
}

function isActionMessage(message: Record<string, unknown>): message is Record<string, unknown> & {
    actionId: string;
    description: string;
    inputs: Record<string, unknown>;
    connectionId?: string;
} {
    return (
        typeof message.actionId === 'string' &&
        typeof message.description === 'string' &&
        isIndexableRecord(message.inputs) &&
        !Array.isArray(message.inputs) &&
        (message.connectionId === undefined || typeof message.connectionId === 'string')
    );
}

interface ChildRun {
    func: BackendFunction;
    config: Omit<ChildStartConfig, 'installGuards'>;
    allowedConnectionIds: string[];
    executeAction: ExecuteAction;
    timeoutMs: number;
    longPolling: Required<LongPollingOptions>;
    prefix: string;
}

export function createChildProcessExecutor(
    options: ChildProcessExecutorOptions,
): ChildProcessExecutor {
    const {
        invokeChannel,
        projectRoot,
        childEntryPath,
        moduleRunnerPath,
        readRoots,
        denyPatterns,
        restrictModuleLoads,
        resolveModule,
        log,
        writeOutput = writeToTerminal,
        nodeFlags = process.allowedNodeEnvironmentFlags,
        isInspectorActive = isDebuggerAttached,
        flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
    } = options;
    const moduleRunnerUrl = pathToFileURL(moduleRunnerPath).href;
    // Node checks read access on each linked part of the entry's path while it starts.
    const [realChildEntryPath = childEntryPath] = withRealPath(childEntryPath).slice(-1);
    let callCount = 0;

    const ownChildren: ChildTmpDirs = new Map();
    let closed = false;
    const refuseIfClosed = (func: BackendFunction) => {
        if (closed) {
            throw new Error(
                `Local execution of "${func.name}" didn't start: its dev server closed`,
            );
        }
    };

    const runChild = async (run: ChildRun): Promise<BackendOutputs> => {
        const { func, config, allowedConnectionIds, executeAction, timeoutMs, prefix } = run;
        // A call still starting when its server closed must not fork on the closed server.
        refuseIfClosed(func);
        const { actionCallTimeoutMs, totalExecutionTimeoutMs } = deriveActionTimeouts(
            run.longPolling,
        );
        const systemTmpDir = os.tmpdir();
        const tmpPrefix = path.join(systemTmpDir, 'dd-apps-exec-');
        const createdTmpDir = fs.mkdtempSync(tmpPrefix);
        const tmpDir = fs.realpathSync.native(createdTmpDir);
        const inspect = isInspectorActive();
        let child: ChildProcess;
        let readPaths: string[];
        let sandboxArgv: string[] | undefined;
        try {
            readPaths = collectReadPaths(projectRoot, childEntryPath, moduleRunnerPath, readRoots);
            sandboxArgv = permissionModelArgv({
                readPaths,
                writePaths: [tmpDir, ...sharedTmpPaths()],
                nodeFlags,
                inspect,
            });
            const execArgv = [
                `--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`,
                ...(sandboxArgv ?? []),
            ];
            if (inspect) {
                execArgv.push('--inspect=127.0.0.1:0');
            }
            child = fork(realChildEntryPath, [], {
                // Not the project, so a dependency loading `.env` from the working directory finds none.
                cwd: tmpDir,
                env: buildChildEnv(tmpDir),
                execArgv,
                serialization: 'json',
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            });
        } catch (error) {
            rmSync(tmpDir);
            throw error;
        }
        log.debug(
            `Executing "${func.name}" in a child process (pid ${child.pid}, temp dir ${tmpDir}) with args`,
        );
        trackChild(child, tmpDir, ownChildren);

        let ranOutOfMemory = false;
        const writeChildLine = (stream: OutputStream) => (line: string) => {
            ranOutOfMemory ||= stream === 'stderr' && V8_OUT_OF_MEMORY_LINE.test(line);
            writeOutput(stream, `${prefix} ${line}`);
        };
        if (child.stdout && child.stderr) {
            const writeStdoutLine = writeChildLine('stdout');
            const writeStderrLine = writeChildLine('stderr');
            forwardLines(child.stdout, writeStdoutLine);
            forwardLines(child.stderr, writeStderrLine);
        }

        const resolutionScope = new Set<string>();
        const inResolutionScope = <T>(work: () => T): T =>
            localExecutionResolutionContext.run(resolutionScope, work);
        const moduleLoadGuard = createModuleLoadGuard({
            readPaths: restrictModuleLoads ? readPaths : undefined,
            denyPatterns,
            resolveModule: (url, importer) => inResolutionScope(() => resolveModule(url, importer)),
        });
        return new Promise<BackendOutputs>((resolve, reject) => {
            let settled = false;
            let loaded = false;
            let outcome: { data: unknown } | undefined;
            let pendingActionCalls = 0;
            let loadTimer: ReturnType<typeof setTimeout> | undefined;
            let hangTimer: ReturnType<typeof setTimeout> | undefined;
            let absoluteTimer: ReturnType<typeof setTimeout> | undefined;

            const finish = (error: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(loadTimer);
                clearTimeout(hangTimer);
                clearTimeout(absoluteTimer);
                child.kill('SIGKILL');
                reject(error);
            };
            const fail = (message: string) => {
                const error = new Error(message);
                finish(error);
            };
            // A paused breakpoint would otherwise count against the call's time budget.
            const isTimed = !inspect;
            // Loading gets its own budget before the call's, as it does in-process.
            const startLoadTimer = () => {
                if (!isTimed) {
                    return;
                }
                loadTimer = setTimeout(() => {
                    fail(
                        `Loading "${func.relativePath}/${func.name}" timed out after ${timeoutMs}ms`,
                    );
                }, timeoutMs);
            };
            const scheduleHangTimer = () => {
                clearTimeout(hangTimer);
                if (!isTimed || !loaded || pendingActionCalls > 0) {
                    return;
                }
                hangTimer = setTimeout(() => {
                    fail(`Local execution of "${func.name}" timed out after ${timeoutMs}ms`);
                }, timeoutMs);
            };
            const rearmAbsoluteTimer = () => {
                clearTimeout(absoluteTimer);
                if (!isTimed || !loaded) {
                    return;
                }
                absoluteTimer = setTimeout(() => {
                    fail(
                        `Local execution of "${func.name}" exceeded the absolute ${totalExecutionTimeoutMs}ms execution ceiling, regardless of any $.Actions call in flight.`,
                    );
                }, totalExecutionTimeoutMs);
            };
            const reply = (message: ParentMessage) => {
                if (settled || !child.connected) {
                    return;
                }
                child.send(message, (error) => {
                    if (error && !settled) {
                        log.debug(
                            `Couldn't reply to "${func.name}"'s child process: ${error.message}`,
                        );
                    }
                });
            };

            const onInvoke = async (id: number, request: InvokeRequest) => {
                const [url, importer] = request.args;
                if (request.name === 'fetchModule' && typeof url === 'string') {
                    const refusal = await moduleLoadGuard.refusalBeforeLoad(url, importer);
                    if (refusal) {
                        reply({ type: 'invoke-result', id, response: refusal });
                        return;
                    }
                }
                const hotPayload: HotPayload = {
                    type: 'custom',
                    event: 'vite:invoke',
                    data: { id: request.invokeId, name: request.name, data: request.args },
                };
                const response = await inResolutionScope(() =>
                    invokeChannel.handleInvoke(hotPayload),
                );
                const checkedResponse = moduleLoadGuard.checkResponse(response);
                reply({ type: 'invoke-result', id, response: checkedResponse });
            };

            const onAction = async (
                id: number,
                message: {
                    actionId: string;
                    description: string;
                    inputs: Record<string, unknown>;
                    connectionId?: string;
                },
            ) => {
                const replyWithError = (error: unknown) => {
                    const thrownString = typeof error === 'string';
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    reply({
                        type: 'action-result',
                        id,
                        ok: false,
                        message: errorMessage,
                        thrownString,
                    });
                };
                let validated: {
                    inputs: Record<string, unknown>;
                    connectionId: string | undefined;
                };
                // Before the timers, so a refused call can't keep extending the call's time budget.
                try {
                    validated = validateActionCall(
                        message,
                        allowedConnectionIds,
                        message.description,
                    );
                } catch (error) {
                    replyWithError(error);
                    return;
                }
                const { inputs, connectionId } = validated;
                pendingActionCalls += 1;
                clearTimeout(hangTimer);
                rearmAbsoluteTimer();
                try {
                    const actionCall = executeAction(message.actionId, inputs, connectionId);
                    const value = await withTimeout(
                        actionCall,
                        actionCallTimeoutMs,
                        `$.Actions call to "${message.actionId}"`,
                    );
                    reply({ type: 'action-result', id, ok: true, value });
                } catch (error) {
                    replyWithError(error);
                } finally {
                    pendingActionCalls -= 1;
                    if (pendingActionCalls === 0 && !settled && !outcome) {
                        scheduleHangTimer();
                    }
                }
            };

            child.on('message', (message: unknown) => {
                if (settled || !isIndexableRecord(message) || outcome) {
                    return;
                }
                const id = message.id;
                if (message.type === 'invoke' && typeof id === 'number') {
                    const replyWithError = (reason: string) => {
                        const response = { error: { name: 'Error', message: reason } };
                        reply({ type: 'invoke-result', id, response });
                    };
                    const request = invokeRequest(message);
                    if (!request) {
                        replyWithError('Malformed module runner request.');
                        return;
                    }
                    onInvoke(id, request).catch((error: unknown) => {
                        const reason = error instanceof Error ? error.message : String(error);
                        replyWithError(reason);
                    });
                } else if (message.type === 'action' && typeof id === 'number') {
                    if (isActionMessage(message)) {
                        onAction(id, message).catch(() => {});
                    } else {
                        reply({
                            type: 'action-result',
                            id,
                            ok: false,
                            message:
                                'Malformed $.Actions request: it needs a string actionId, an inputs object and an optional string connectionId.',
                            thrownString: false,
                        });
                    }
                } else if (message.type === 'loaded' && !loaded) {
                    loaded = true;
                    clearTimeout(loadTimer);
                    scheduleHangTimer();
                    rearmAbsoluteTimer();
                } else if (message.type === 'result') {
                    outcome = { data: message.data };
                    clearTimeout(loadTimer);
                    clearTimeout(hangTimer);
                    clearTimeout(absoluteTimer);
                    child.kill('SIGKILL');
                } else if (message.type === 'error') {
                    const reason =
                        typeof message.message === 'string' ? message.message : 'Unknown error';
                    if (typeof message.detail === 'string') {
                        finish(new FunctionThrewError(reason, message.detail));
                    } else {
                        fail(reason);
                    }
                }
            });
            // A process that fails to start may never emit 'close'.
            child.on('error', (error) => {
                rm(tmpDir).catch(() => {});
                finish(error);
            });
            child.on('close', (code, signal) => {
                rm(tmpDir).catch(() => {});
                if (outcome) {
                    settled = true;
                    resolve(outcome);
                    return;
                }
                const ending = signal ? `signal ${signal}` : `exit code ${code}`;
                const reason = ranOutOfMemory
                    ? `ran out of memory (${CHILD_MAX_OLD_SPACE_MB} MB)`
                    : `ended before returning a result (${ending})`;
                fail(`Local execution of "${func.name}" ${reason}`);
            });

            startLoadTimer();
            reply({
                type: 'start',
                config: { ...config, installGuards: sandboxArgv === undefined },
            });
        });
    };

    const execute: LocalExecutor = async (request) => {
        const { func, args, executeAction, getRuntimeContext, getAllowedConnectionIds } = request;
        refuseIfClosed(func);
        const displayName = `${func.relativePath}/${func.name}`;
        const runtimeContext = await getRuntimeContext();
        assertValidRuntimeContext(runtimeContext);
        const connectionIdsResolving = getAllowedConnectionIds(func.absolutePath);
        const allowedConnectionIds = await withTimeout(
            connectionIdsResolving,
            request.timeoutMs,
            `Resolving allowed connections for "${displayName}"`,
        );
        const actionCatalogInstalled = isActionCatalogInstalled(projectRoot);
        const appsBackendInstalled = isDatadogAppsBackendInstalled(projectRoot);
        callCount += 1;
        return runChild({
            func,
            allowedConnectionIds,
            executeAction,
            timeoutMs: request.timeoutMs,
            longPolling: request.longPolling,
            prefix: `[${func.name}#${callCount}]`,
            config: {
                moduleRunnerUrl,
                projectRoot,
                entryUrl: func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX,
                entryPath: func.absolutePath,
                functionName: func.name,
                args,
                runtimeContext,
                actionCatalogInstalled,
                appsBackendInstalled,
                flushTimeoutMs,
            },
        });
    };
    const close = () => {
        closed = true;
        killChildren(ownChildren);
    };
    return Object.assign(execute, { close });
}
