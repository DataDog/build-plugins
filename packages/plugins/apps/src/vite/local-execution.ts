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
import { fork } from 'child_process';
import * as path from 'path';

import type { BackendFunction } from '../backend/types';

type BackendOutputs = { data: unknown };

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
        let settled = false;

        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                child.kill();
                reject(
                    new Error(`Local execution of "${func.name}" timed out after ${timeoutMs}ms`),
                );
            }
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

            if (msg.type === 'result' && !settled) {
                settled = true;
                clearTimeout(timer);
                resolve({ data: msg.result });
                return;
            }

            if (msg.type === 'error' && !settled) {
                settled = true;
                clearTimeout(timer);
                reject(new Error(msg.error));
            }
        });

        child.on('exit', (code) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(
                    new Error(
                        `Local execution of "${func.name}" exited with code ${code} before reporting a result`,
                    ),
                );
            }
        });

        child.on('error', (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(err);
            }
        });

        child.send({ type: 'execute', scriptBody, backendFunctionArgs: args });
    });
}
