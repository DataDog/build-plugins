// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

// Runs one backend function call in its own process, forked by the dev server's local execution.
// Modules come from the dev server over IPC; `$.Actions` calls go back to it for scope checks and credentials.

import nodeModule from 'node:module';
import type { Writable } from 'node:stream';

import type { ChildMessage, ChildStartConfig, ParentMessage } from './local-execution-protocol';
import { isParentMessage } from './local-execution-protocol';
import type { ActionCallArgs } from './local-execution-shared';
import {
    assertJsonRoundTrippable,
    assertNoSelfDeclaredScope,
    describeError,
    isIndexableRecord,
    makeActionsProxy,
    returnValueSubject,
    serializeActionInputs,
    validateActionCallShape,
} from './local-execution-shared';
import { installGuards, runBlocked } from './network-guard';

type ModuleRunnerInstance = { import(url: string): Promise<Record<string, unknown>> };
type CreateImportMeta = (modulePath: string) => unknown;
type ModuleRunnerOptions = {
    transport: { invoke(payload: unknown): Promise<unknown> };
    hmr: false;
    createImportMeta?: CreateImportMeta;
};
type ModuleRunnerModule = {
    ModuleRunner: new (options: ModuleRunnerOptions, evaluator: unknown) => ModuleRunnerInstance;
    ESModulesEvaluator: new () => unknown;
    createNodeImportMeta: CreateImportMeta;
};

type Settle = { resolve(value: unknown): void; reject(error: Error): void };

const send = process.send?.bind(process);
let nextRequestId = 0;
const pendingInvokes = new Map<number, Settle>();
const pendingActions = new Map<number, Settle>();

function sendMessage(message: ChildMessage): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!send) {
            reject(new Error('Local execution child process has no IPC channel.'));
            return;
        }
        send(message, undefined, undefined, (error: Error | null) =>
            error ? reject(error) : resolve(),
        );
    });
}

function request(
    pending: Map<number, Settle>,
    id: number,
    message: ChildMessage,
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        sendMessage(message).catch((error: Error) => {
            pending.delete(id);
            reject(error);
        });
    });
}

function invoke(payload: unknown): Promise<unknown> {
    const id = ++nextRequestId;
    return request(pendingInvokes, id, { type: 'invoke', id, payload });
}

async function dispatchAction(
    actionId: string,
    call: Partial<ActionCallArgs>,
    description: string,
): Promise<unknown> {
    const { inputs, connectionId } = validateActionCallShape(call, description);
    const serializedInputs = serializeActionInputs(inputs, description);
    assertNoSelfDeclaredScope(serializedInputs, description);
    const id = ++nextRequestId;
    return request(pendingActions, id, {
        type: 'action',
        id,
        actionId,
        description,
        inputs: serializedInputs,
        ...(connectionId === undefined ? {} : { connectionId }),
    });
}

function onParentMessage(message: ParentMessage): void {
    if (message.type === 'start') {
        run(message.config).catch(() => {});
    } else if (message.type === 'invoke-result') {
        pendingInvokes.get(message.id)?.resolve(message.response);
        pendingInvokes.delete(message.id);
    } else if (message.type === 'action-result') {
        const settle = pendingActions.get(message.id);
        pendingActions.delete(message.id);
        if (message.ok) {
            settle?.resolve(message.value);
        } else {
            const error = new Error(message.message);
            settle?.reject(error);
        }
    }
}

async function registerSdkAdapters(
    runner: ModuleRunnerInstance,
    config: ChildStartConfig,
    $: Record<string, unknown>,
): Promise<void> {
    if (config.actionCatalogInstalled) {
        const actionExecution = await runner.import('@datadog/action-catalog/action-execution');
        const { setExecuteActionImplementation } = actionExecution;
        if (typeof setExecuteActionImplementation === 'function') {
            setExecuteActionImplementation((actionId: string, actionRequest: unknown) => {
                const call = isIndexableRecord(actionRequest) ? actionRequest : {};
                return dispatchAction(actionId, call, `"${actionId}"`);
            });
        }
    }
    if (config.appsBackendInstalled) {
        const [jsFunctionWithActions, runtime] = await Promise.all([
            runner.import('@datadog/apps-backend/runtime/jsFunctionWithActions'),
            runner.import('@datadog/apps-backend/runtime'),
        ]);
        const { buildRuntimeFromJsFunctionWithActions } = jsFunctionWithActions;
        const { setBackend } = runtime;
        if (
            typeof buildRuntimeFromJsFunctionWithActions === 'function' &&
            typeof setBackend === 'function'
        ) {
            const backend = buildRuntimeFromJsFunctionWithActions($);
            setBackend(backend);
        }
    }
}

const writeStdout = process.stdout.write;
const writeStderr = process.stderr.write;

// A write callback fires once earlier writes are flushed, which a pipe on macOS does asynchronously.
// Uses the original write, and gives up after a while, in case the call replaced or broke it.
function flush(stream: Writable, write: Writable['write'], timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        Reflect.apply(write, stream, [
            '',
            () => {
                clearTimeout(timer);
                resolve();
            },
        ]);
    });
}

async function load(config: ChildStartConfig): Promise<unknown> {
    const { ModuleRunner, ESModulesEvaluator, createNodeImportMeta }: ModuleRunnerModule =
        await import(config.moduleRunnerUrl);
    // Declared, so top-level code reading `$` sees undefined as in production rather than a ReferenceError.
    Reflect.set(globalThis, '$', undefined);
    const evaluator = new ESModulesEvaluator();
    // Without `module.registerHooks`, Vite resolves it on a hooks thread, which the permission model refuses.
    const resolvesImportMeta = config.installGuards || 'registerHooks' in nodeModule;
    // Without it, Vite's runner gives modules an import.meta.resolve that always throws.
    const runnerOptions: ModuleRunnerOptions = {
        transport: { invoke },
        hmr: false,
        ...(resolvesImportMeta && { createImportMeta: createNodeImportMeta }),
    };
    const runner = new ModuleRunner(runnerOptions, evaluator);
    const mod = await runner.import(config.entryUrl);
    const fn = mod[config.functionName];
    if (typeof fn !== 'function') {
        throw new Error(
            `"${config.functionName}" is not a function exported from ${config.entryPath}`,
        );
    }
    const $ = {
        ...config.runtimeContext,
        backendFunctionArgs: config.args,
        Actions: makeActionsProxy(dispatchAction),
    };
    Reflect.set(globalThis, '$', $);
    await registerSdkAdapters(runner, config, $);
    await sendMessage({ type: 'loaded' });
    const returned = await fn(...config.args);
    const subject = returnValueSubject(config.functionName);
    return assertJsonRoundTrippable(returned, subject);
}

// Without the permission model, the guards cover the module's top-level code as well as the call.
function execute(config: ChildStartConfig): Promise<unknown> {
    if (!config.installGuards) {
        return load(config);
    }
    installGuards();
    return runBlocked(() => load(config));
}

async function run(config: ChildStartConfig): Promise<void> {
    let outcome: ChildMessage;
    try {
        const data = await execute(config);
        outcome = { type: 'result', data };
    } catch (error) {
        outcome = {
            type: 'error',
            message: describeError(error),
        };
    }
    const stdoutFlushed = flush(process.stdout, writeStdout, config.flushTimeoutMs);
    const stderrFlushed = flush(process.stderr, writeStderr, config.flushTimeoutMs);
    await Promise.all([stdoutFlushed, stderrFlushed]);
    await sendMessage(outcome);
}

// A dev server that exits or restarts leaves no call running on its own.
process.on('disconnect', () => process.exit(1));

process.on('message', (message: unknown) => {
    if (isParentMessage(message)) {
        onParentMessage(message);
    }
});
