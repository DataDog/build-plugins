// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Local Node execution for backend functions -- the "Mode A" path described
 * in the design doc (.plans/high-code-apps-local-node-execution-design.md
 * in dd-source). This is an implementation POC, not production code: it is
 * NOT wired into createDevServerMiddleware, and executeActionRemotely below
 * is a stub for the single-action execution endpoint that doesn't exist yet
 * (see the design doc's "Open Dependency" section).
 *
 * Parallel structure to executeScriptViaDatadog in dev-server.ts: same
 * BackendOutputs return shape, so it's a drop-in alternate implementation
 * behind the same contract, not a protocol change.
 */

import type { Logger } from '@dd/core/types';
import type { ChildProcess } from 'child_process';
import { fork } from 'child_process';
import * as path from 'path';

import type { BackendFunction } from '../backend/types';

type BackendOutputs = { data: unknown };

// Tracks every child currently executing a backend function, so the dev
// server can kill them all on its own shutdown instead of leaving orphaned
// Node processes behind (see killAllLocalExecutionChildren below). A Set
// rather than a single reference because multiple executions can be
// in-flight concurrently -- each gets its own forked child (pooling is
// deliberately deferred, see the design doc's Timeline section).
const liveChildren = new Set<ChildProcess>();

/**
 * Kill every backend-function child process currently executing. Call this
 * from the dev server's own shutdown handling (SIGINT/SIGTERM/process exit)
 * once local execution is wired in -- not yet called anywhere, since this
 * file isn't wired into createDevServerMiddleware yet.
 */
export function killAllLocalExecutionChildren(): void {
    for (const child of liveChildren) {
        child.kill();
    }
}

/** Test-only: exposes the most recently forked child so tests can exercise real signal-based kills. */
export function getMostRecentlyForkedChildForTest(): ChildProcess | undefined {
    return Array.from(liveChildren).at(-1);
}

interface ActionRequestMessage {
    type: 'action-request';
    id: number;
    fqn: string;
    inputs: Record<string, unknown>;
    connectionId?: string;
}

type ChildMessage =
    | ActionRequestMessage
    | { type: 'result'; result: unknown }
    | { type: 'error'; error: string };

const LOCAL_EXEC_CHILD_SCRIPT = path.join(__dirname, 'local-exec-child.js');
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * TODO(open-dependency): stub for the single-action execution capability the
 * design doc asks the Action Platform team to build (a new REST endpoint or
 * an MCP tool -- see "Open Dependency"). This is the ONLY function that
 * reaches outward for a real $.Actions call; once the real endpoint exists,
 * only this function's body needs to change.
 */
async function executeActionRemotely(
    request: ActionRequestMessage,
    log: Logger,
): Promise<{ type: 'success' | 'failure'; result: unknown }> {
    log.debug(
        `[local-execution] (stub -- no real endpoint exists yet) would call ${request.fqn} with inputs=${JSON.stringify(request.inputs)}`,
    );
    return { type: 'success', result: { data: null, stub: true, fqn: request.fqn } };
}

/**
 * Execute a bundled backend function locally via a forked Node child process,
 * with $.Actions calls proxied back through this function (which currently
 * stubs the outward call -- see executeActionRemotely above).
 */
export function executeScriptLocally(
    scriptBody: string,
    func: BackendFunction,
    args: unknown[],
    log: Logger,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BackendOutputs> {
    return new Promise((resolve, reject) => {
        // NOTE: production implementation must pass an explicit restricted
        // `env`, never inherit process.env wholesale -- see the design doc's
        // Secrets Handling section (never hand secrets to the child).
        const child = fork(LOCAL_EXEC_CHILD_SCRIPT, [], { stdio: 'inherit', env: {} });
        liveChildren.add(child);
        let settled = false;

        const settle = (fn: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            liveChildren.delete(child);
            fn();
        };

        const timer = setTimeout(() => {
            settle(() => {
                child.kill();
                reject(
                    new Error(`Local execution of "${func.name}" timed out after ${timeoutMs}ms`),
                );
            });
        }, timeoutMs);

        child.on('message', (msg: ChildMessage) => {
            if (!msg) {
                return;
            }

            if (msg.type === 'action-request') {
                executeActionRemotely(msg, log)
                    .then((response) => {
                        child.send({ type: 'action-response', id: msg.id, payload: response });
                    })
                    .catch((err: unknown) => {
                        child.send({
                            type: 'action-response',
                            id: msg.id,
                            payload: { type: 'failure', result: String(err) },
                        });
                    });
                return;
            }

            if (msg.type === 'result') {
                settle(() => {
                    clearTimeout(timer);
                    resolve({ data: msg.result });
                });
                return;
            }

            if (msg.type === 'error') {
                settle(() => {
                    clearTimeout(timer);
                    reject(new Error(msg.error));
                });
            }
        });

        child.on('exit', (code, signal) => {
            settle(() => {
                clearTimeout(timer);
                // A signal (not a plain exit code) means the OS terminated the
                // process directly -- most commonly an OOM kill (SIGKILL) or a
                // native-module crash (SIGSEGV/SIGABRT). Report it explicitly:
                // "exited with code null" is meaningless to a developer trying
                // to tell an OOM apart from a native-module crash.
                const cause = signal
                    ? `was killed by signal ${signal}`
                    : `exited with code ${code}`;
                reject(
                    new Error(
                        `Local execution of "${func.name}" ${cause} before reporting a result`,
                    ),
                );
            });
        });

        child.on('error', (err) => {
            settle(() => {
                clearTimeout(timer);
                reject(err);
            });
        });

        child.send({ type: 'execute', scriptBody, backendFunctionArgs: args });
    });
}
