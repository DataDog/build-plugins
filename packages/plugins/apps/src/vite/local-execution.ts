// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global Proxy, globalThis */

/** Executes a backend function's file directly in-process inside the Vite dev server — a drop-in alternate to dev-server.ts's executeScriptViaDatadog, mirroring its `BackendOutputs` contract. */

import type { Logger } from '@dd/core/types';
import { AsyncLocalStorage } from 'node:async_hooks';

import { isActionCatalogInstalled, isDatadogAppsBackendInstalled } from '../backend/shared';
import type { BackendFunction, BackendOutputs } from '../backend/types';
import { LOCAL_EXECUTION_LOAD_SUFFIX } from '../constants';
import type { LongPollingOptions } from '../types';
import { resolveLongPolling } from '../validate';

import { createEpochGuard } from './execution-epoch';
import type { ActionCallArgs } from './local-execution-shared';
import {
    assertJsonRoundTrippable,
    assertNoSelfDeclaredScope,
    callBackendFunction,
    isIndexableRecord,
    makeActionsProxy,
    returnValueSubject,
    serializeActionInputs,
    validateActionCall,
} from './local-execution-shared';
import { assertNoForeignGuard, installGuards, runBlocked } from './network-guard';
import { getTotalRetryDelayBudgetMs } from './retry-delay';

type RuntimeUser = {
    id: string;
    orgId: string;
    email?: string | null;
    name?: string | null;
};

export type RuntimeContext = Record<string, unknown> & {
    Source: {
        initiator: RuntimeUser;
        runAsUser: RuntimeUser;
    };
};

type BackendGlobals = RuntimeContext & {
    backendFunctionArgs: unknown[];
    Actions: unknown;
};

/** Boxed so a customer module assigning to `globalThis.$` (e.g. `zx/globals`) mutates only its own execution's box, never a concurrent or zombie execution's. */
type BackendGlobalsBox = { value: unknown };

/** Scopes `globalThis.$` per execution via AsyncLocalStorage so a zombie execution's late "fresh" read resolves to its own `$`, never a newer execution's identity. */
const backendGlobalsContext = new AsyncLocalStorage<BackendGlobalsBox>();

/** Whether `$` was installed (e.g. by `zx/globals`) before this module's own accessor — distinguishes that legitimate passthrough from a customer module reaching for `$` with no prior value, which should fail like production does. */
const hadPreexistingDollar = Reflect.has(globalThis, '$');

/** Marks the window where a customer module's own top-level code is loading (narrower than "between executions," where the undefined-returning fallback below applies instead). Carries its own mutable box so a top-level `$` write (e.g. `zx/globals`) is scoped to this load, not the shared `globalDollarOutsideExecution` slot a later, unrelated load would also read. */
const customerModuleLoadContext = new AsyncLocalStorage<{ assigned: boolean; value: unknown }>();

/** Scopes vite/index.ts's suffixed-subgraph tracking to one entry's own module-graph traversal — every caller funnels through `loadCustomerModuleEntry`, so scoping here reaches every path uniformly. Without this, a process-wide Set would let a helper module stay marked for the dev server's whole lifetime, so a later unrelated SSR resolution of that helper would inherit the marker and serve real backend code instead of the frontend RPC-proxy stub. */
export const localExecutionResolutionContext = new AsyncLocalStorage<Set<string>>();

/** Backs `globalThis.$` outside any execution box; seeded from any `$` already installed before this module loaded so the accessor below doesn't discard a legitimate `zx/globals`-style passthrough. */
let globalDollarOutsideExecution: unknown = Reflect.get(globalThis, '$');

function ensureDollarAccessorInstalled(): void {
    if (Object.getOwnPropertyDescriptor(globalThis, '$')?.get === dollarGetter) {
        return;
    }
    Object.defineProperty(globalThis, '$', {
        configurable: true,
        enumerable: true,
        get: dollarGetter,
        set: dollarSetter,
    });
}

function dollarGetter(): unknown {
    const box = backendGlobalsContext.getStore();
    if (box) {
        return box.value;
    }
    const loadBox = customerModuleLoadContext.getStore();
    if (loadBox) {
        if (loadBox.assigned) {
            return loadBox.value;
        }
        if (hadPreexistingDollar) {
            return globalDollarOutsideExecution;
        }
        // Matches production: $ isn't global until main() assigns it, so it reads as undefined
        // rather than throwing, even though it's a real accessor property here, not absent.
        return undefined;
    }
    return globalDollarOutsideExecution;
}

function dollarSetter(value: unknown): void {
    const box = backendGlobalsContext.getStore();
    if (box) {
        box.value = value;
        return;
    }
    const loadBox = customerModuleLoadContext.getStore();
    if (loadBox) {
        // Scoped to this load, not globalDollarOutsideExecution — otherwise a top-level write (e.g. zx/globals) would leak into every later, unrelated load.
        loadBox.assigned = true;
        loadBox.value = value;
        return;
    }
    globalDollarOutsideExecution = value;
}

ensureDollarAccessorInstalled();

/** What the stable, once-ever-registered adapters below need to dispatch a call to whichever execution is live on the AsyncLocalStorage stack — kept out of `BackendGlobals` since that's also `globalThis.$`, visible to customer code. */
type ExecutionDispatch = {
    executeAction: ExecuteAction;
    allowedConnectionIds: string[];
    isAbandoned: () => boolean;
    functionName: string;
    $: BackendGlobals;
};

/** Distinct from `backendGlobalsContext` so dispatch-only fields (the real `executeAction`, `allowedConnectionIds`) never leak onto `globalThis.$`. */
const executionDispatchContext = new AsyncLocalStorage<ExecutionDispatch>();

function assertRuntimeUser(value: unknown, label: string): asserts value is RuntimeUser {
    if (!isIndexableRecord(value) || Array.isArray(value)) {
        throw new Error(`The preview runtime context ${label} must be an object.`);
    }
    if (typeof value.id !== 'string' || value.id.length === 0) {
        throw new Error(
            `The preview runtime context ${label} must have a non-empty string "id" field.`,
        );
    }
    if (typeof value.orgId !== 'string' || value.orgId.length === 0) {
        throw new Error(
            `The preview runtime context ${label} must have a non-empty string "orgId" field.`,
        );
    }
    if (value.email !== undefined && value.email !== null && typeof value.email !== 'string') {
        throw new Error(
            `The preview runtime context ${label} must have a string "email" field when provided.`,
        );
    }
    if (value.name !== undefined && value.name !== null && typeof value.name !== 'string') {
        throw new Error(
            `The preview runtime context ${label} must have a string "name" field when provided.`,
        );
    }
}

/** Validates the identity-bearing minimum of the preview-provided `$` snapshot before any customer module is loaded. */
export function assertValidRuntimeContext(value: unknown): asserts value is RuntimeContext {
    if (!isIndexableRecord(value) || Array.isArray(value)) {
        throw new Error('The preview runtime context must be an object.');
    }
    const source = value.Source;
    if (!isIndexableRecord(source) || Array.isArray(source)) {
        throw new Error('The preview runtime context must have a "Source" object.');
    }
    assertRuntimeUser(source.initiator, 'Source.initiator');
    assertRuntimeUser(source.runAsUser, 'Source.runAsUser');
}

export const DEFAULT_TIMEOUT_MS = 10_000;

type LongPollingConfig = Required<LongPollingOptions>;

// Derived from validate.ts's own resolveLongPolling rather than a hardcoded copy, so callers get
// the same effective ceilings a real dev server derives without each passing one in.
export const DEFAULT_LONG_POLLING_CONFIG: LongPollingConfig = resolveLongPolling(undefined);

/**
 * Both ceilings must exceed `pollQueryExecution`'s worst-case budget: polling time
 * (`maxRetries * timeoutMs`) plus the retry-delay budget. Exported so tests compute the expected
 * value instead of hardcoding a copy.
 */
export function deriveActionTimeouts(longPolling: LongPollingConfig): {
    actionCallTimeoutMs: number;
    totalExecutionTimeoutMs: number;
} {
    const worstCaseMs =
        longPolling.maxRetries * longPolling.timeoutMs + getTotalRetryDelayBudgetMs(longPolling);
    return {
        // Bounds a single $.Actions call, exempt from the hang-detection timer — doRequest has
        // no deadline of its own, so an unsettled call would wedge the whole serialized queue.
        actionCallTimeoutMs: worstCaseMs * 2,
        // Absolute wall-clock ceiling, independent of the pause-and-extend mechanism above —
        // that can't tell a genuinely slow $.Actions call from a fire-and-forgot one masking a
        // real hang, so this bounds the masked case tighter without cutting off legitimate calls.
        totalExecutionTimeoutMs: worstCaseMs * 1.2,
    };
}

/** Loads a module by specifier, resolved against the customer's own project rather than build-plugins' dependency tree — the dev server passes its Vite instance's `ssrLoadModule` here. */
export type LoadModule = (specifier: string) => Promise<Record<string, unknown>>;

/** Loads a customer module under the same top-level `$`-scoping `runScriptLocally` uses, for callers (like `executeColdActionLocally`'s priming) that evaluate it before `runScriptLocally`. Its top-level code runs before `runBlocked`, so it isn't guarded; installing first still hands it the guarded fs/child_process functions. */
export async function loadCustomerModuleEntry(
    loadModule: LoadModule,
    entrySpecifier: string,
): Promise<Record<string, unknown>> {
    installGuards();
    // Checked before the customer's top-level code runs, since runBlocked would refuse anyway.
    assertNoForeignGuard();
    return localExecutionResolutionContext.run(new Set(), () =>
        customerModuleLoadContext.run({ assigned: false, value: undefined }, () =>
            loadModule(entrySpecifier),
        ),
    );
}

/** Executes a real `$.Actions.foo.bar(...)` call; the dev server supplies the implementation using its own auth, so this module never holds or sees a credential itself. */
export type ExecuteAction = (
    fqn: string,
    inputs: unknown,
    connectionId: string | undefined,
) => Promise<unknown>;

/** Resolves a fresh serializable `$` snapshot from an authenticated preview execution. */
export type GetRuntimeContext = () => Promise<unknown>;

/** Shared validate → serialize → dispatch sequence for both $.Actions entry points — same reasoning as `validateActionCall` above, extended to cover the whole call instead of just the inputs check. */
async function invokeAction(
    executeAction: ExecuteAction,
    actionId: string,
    call: Partial<ActionCallArgs>,
    allowedConnectionIds: string[],
    actionDescription: string,
): Promise<unknown> {
    const { inputs, connectionId } = validateActionCall(
        call,
        allowedConnectionIds,
        actionDescription,
    );
    const serializedInputs = serializeActionInputs(inputs, actionDescription);
    assertNoSelfDeclaredScope(serializedInputs, actionDescription);
    return executeAction(actionId, serializedInputs, connectionId);
}

/** Serializes local executions — a customer function deleting `globalThis.$` mid-flight would otherwise break `$` access for any other execution concurrently in progress (see `ensureDollarAccessorInstalled`). */
let queueTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = queueTail.then(run);
    queueTail = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

// Shared wording for the "no longer current" rejection at every abandonment call site.
function abandonedExecutionError(functionName: string, refusedAction: string): Error {
    return new Error(
        `Execution of "${functionName}" already concluded; refusing to ${refusedAction} ` +
            `as this stale execution to avoid using a newer execution's identity.`,
    );
}

/**
 * One shared guard across all executions — `enqueue` only serializes each execution's start, so a
 * timed-out `fn()` keeps running (abandoned, not canceled). `isCurrent()` rejects that zombie's
 * later dispatch once a newer scope takes over; `concludeIfCurrent()` only clears the generation if
 * its own scope is still active, so delayed cleanup can't clobber a newer scope.
 */
const executionEpoch = createEpochGuard();

/** Bounds a promise that could otherwise hang forever — a `loadModule` call against a broken/circular graph, or a `$.Actions` call with no deadline of its own. Doesn't cancel the underlying promise, so late side effects can still fire if it eventually settles; see each call site for why that's harmless there. `label` is the full subject of the timeout message (e.g. `` `Loading ${specifier}` ``), not a suffix on a fixed prefix. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err: unknown) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

/** Shared once-ever-registration wrapper for both adapters below: no-ops if uninstalled (re-checked uncached, so a mid-session install is picked up on the next execution), caches by `loadModule` identity (true once-ever for a real dev server's reused `ssrLoadModule`, isolated per test), and evicts a rejection so the next execution retries instead of staying poisoned. */
function registerOnceIfInstalled(
    isInstalled: (projectRoot: string) => boolean,
    registrations: WeakMap<LoadModule, Promise<void>>,
    registerOnce: (loadModule: LoadModule, timeoutMs: number) => Promise<void>,
    loadModule: LoadModule,
    projectRoot: string,
    timeoutMs: number,
): Promise<void> {
    if (!isInstalled(projectRoot)) {
        return Promise.resolve();
    }
    const existing = registrations.get(loadModule);
    if (existing) {
        return existing;
    }
    const registration = registerOnce(loadModule, timeoutMs).catch((err) => {
        registrations.delete(loadModule);
        throw err;
    });
    registrations.set(loadModule, registration);
    return registration;
}

/** Keyed by `loadModule` identity — see `registerOnceIfInstalled`'s doc comment. */
const actionCatalogRegistrations = new WeakMap<LoadModule, Promise<void>>();

/** Registers one stable dispatcher for the process lifetime that reads `executionDispatchContext.getStore()` at call time, so a zombie's typed-wrapper call can never dispatch under a newer execution's identity. */
function registerActionCatalogIfInstalled(
    loadModule: LoadModule,
    projectRoot: string,
    timeoutMs: number,
): Promise<void> {
    return registerOnceIfInstalled(
        isActionCatalogInstalled,
        actionCatalogRegistrations,
        registerActionCatalogOnce,
        loadModule,
        projectRoot,
        timeoutMs,
    );
}

async function registerActionCatalogOnce(loadModule: LoadModule, timeoutMs: number): Promise<void> {
    const loadPromise = loadModule('@datadog/action-catalog/action-execution');
    const mod = await withTimeout(
        loadPromise,
        timeoutMs,
        'Loading @datadog/action-catalog/action-execution',
    );
    const setExecuteActionImplementation = mod.setExecuteActionImplementation;
    if (typeof setExecuteActionImplementation !== 'function') {
        return;
    }
    setExecuteActionImplementation(async (actionId: string, request: unknown) => {
        const dispatch = executionDispatchContext.getStore();
        if (!dispatch) {
            throw new Error(`No active local execution to run "${actionId}" under.`);
        }
        if (dispatch.isAbandoned()) {
            throw abandonedExecutionError(dispatch.functionName, `run "${actionId}"`);
        }
        const call: Partial<ActionCallArgs> = isIndexableRecord(request) ? request : {};
        return invokeAction(
            dispatch.executeAction,
            actionId,
            call,
            dispatch.allowedConnectionIds,
            `"${actionId}"`,
        );
    });
}

/** Mirrors `actionCatalogRegistrations` — see `registerOnceIfInstalled`'s doc comment. */
const backendRuntimeRegistrations = new WeakMap<LoadModule, Promise<void>>();

/** Registers one stable runtime Proxy for the process lifetime that resolves whichever execution's `$` is live on the AsyncLocalStorage stack, rather than binding to one execution's `$` at registration time. */
function registerBackendRuntimeIfInstalled(
    loadModule: LoadModule,
    projectRoot: string,
    timeoutMs: number,
): Promise<void> {
    return registerOnceIfInstalled(
        isDatadogAppsBackendInstalled,
        backendRuntimeRegistrations,
        registerBackendRuntimeOnce,
        loadModule,
        projectRoot,
        timeoutMs,
    );
}

async function registerBackendRuntimeOnce(
    loadModule: LoadModule,
    timeoutMs: number,
): Promise<void> {
    const loadPromise = Promise.all([
        loadModule('@datadog/apps-backend/runtime/jsFunctionWithActions'),
        loadModule('@datadog/apps-backend/runtime'),
    ]);
    const [jsFunctionWithActionsModule, runtimeModule] = await withTimeout(
        loadPromise,
        timeoutMs,
        'Loading @datadog/apps-backend/runtime',
    );
    const buildRuntimeFromJsFunctionWithActions =
        jsFunctionWithActionsModule.buildRuntimeFromJsFunctionWithActions;
    const setBackend = runtimeModule.setBackend;
    if (
        typeof buildRuntimeFromJsFunctionWithActions !== 'function' ||
        typeof setBackend !== 'function'
    ) {
        return;
    }
    // Cached by dispatch identity, not rebuilt per accessor call — dispatch.$ is fixed for the whole execution.
    const runtimeByDispatch = new WeakMap<ExecutionDispatch, unknown>();
    // Forwards whatever shape the real runtime's property has (nested namespace or flat method) rather than assuming every property is callable.
    const backendRuntimeProxy = new Proxy(
        {},
        {
            get(_target, prop) {
                const dispatch = executionDispatchContext.getStore();
                if (!dispatch) {
                    throw new Error(
                        `No active local execution to resolve an apps-backend accessor under.`,
                    );
                }
                if (dispatch.isAbandoned()) {
                    throw abandonedExecutionError(
                        dispatch.functionName,
                        'resolve a further apps-backend accessor',
                    );
                }
                let runtime = runtimeByDispatch.get(dispatch);
                if (runtime === undefined) {
                    runtime = buildRuntimeFromJsFunctionWithActions(dispatch.$);
                    runtimeByDispatch.set(dispatch, runtime);
                }
                if (!isIndexableRecord(runtime)) {
                    return undefined;
                }
                const value = runtime[String(prop)];
                // A flat method must be bound to the real runtime object, not this Proxy's empty target; a nested namespace is returned as-is since its own methods already bind correctly.
                return typeof value === 'function' ? value.bind(runtime) : value;
            },
        },
    );
    setBackend(backendRuntimeProxy);
}

function assertJsonSerializable(result: unknown, func: BackendFunction): unknown {
    const subject = returnValueSubject(func.name);
    return assertJsonRoundTrippable(result, subject);
}

/**
 * Test-only entry point: exercises `runScriptLocally`'s queue/execution behavior with priming
 * already done via `primedEntry`. Production goes through `executeColdActionLocally` instead, which
 * primes inside the same `enqueue()` call — kept separate so `primedEntry` keeps its current
 * meaning for the tests calling this directly.
 */
export async function executeScriptLocally(
    func: BackendFunction,
    projectRoot: string,
    args: unknown[],
    executeAction: ExecuteAction,
    getRuntimeContext: GetRuntimeContext,
    loadModule: LoadModule,
    log: Logger,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    primedEntry?: Record<string, unknown>,
    longPolling: LongPollingConfig = DEFAULT_LONG_POLLING_CONFIG,
): Promise<BackendOutputs> {
    return enqueue(async () => {
        const runtimeContext = await getRuntimeContext();
        assertValidRuntimeContext(runtimeContext);
        return runScriptLocally(
            func,
            projectRoot,
            args,
            executeAction,
            runtimeContext,
            loadModule,
            log,
            timeoutMs,
            primedEntry,
            longPolling,
        );
    });
}

/**
 * Cold-function entry point: collects `allowedConnectionIds`, then primes and runs the entry in
 * one `enqueue()` call — priming runs real top-level code, so doing it outside the queue would let
 * two cold functions run in parallel. Connection IDs are collected first, executing no code, so a
 * module the static checks reject never runs.
 */
export async function executeColdActionLocally(
    func: BackendFunction,
    projectRoot: string,
    args: unknown[],
    executeAction: ExecuteAction,
    getRuntimeContext: GetRuntimeContext,
    loadModule: LoadModule,
    getAllowedConnectionIds: (entryId: string) => Promise<string[]>,
    log: Logger,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    longPolling: LongPollingConfig = DEFAULT_LONG_POLLING_CONFIG,
): Promise<BackendOutputs> {
    const displayName = `${func.relativePath}/${func.name}`;
    return enqueue(async () => {
        const runtimeContext = await getRuntimeContext();
        assertValidRuntimeContext(runtimeContext);
        // Each step needs its own timeout bound independent of runScriptLocally's, which only
        // starts once its body begins.
        const connectionIdsPromise = getAllowedConnectionIds(func.absolutePath);
        const allowedConnectionIds = await withTimeout(
            connectionIdsPromise,
            timeoutMs,
            `Resolving allowed connections for "${displayName}"`,
        );
        const entrySpecifier = func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX;
        const primingPromise = loadCustomerModuleEntry(loadModule, entrySpecifier);
        const primedEntry = await withTimeout(
            primingPromise,
            timeoutMs,
            `Loading "${displayName}"`,
        );
        // Calls runScriptLocally directly, not executeScriptLocally, to avoid enqueueing twice.
        return runScriptLocally(
            { ...func, allowedConnectionIds },
            projectRoot,
            args,
            executeAction,
            runtimeContext,
            loadModule,
            log,
            timeoutMs,
            primedEntry,
            longPolling,
        );
    });
}

async function runScriptLocally(
    func: BackendFunction,
    projectRoot: string,
    args: unknown[],
    executeAction: ExecuteAction,
    runtimeContext: RuntimeContext,
    loadModule: LoadModule,
    log: Logger,
    timeoutMs: number,
    primedEntry: Record<string, unknown> | undefined,
    longPolling: LongPollingConfig,
): Promise<BackendOutputs> {
    // Never log the args themselves — they may carry secrets/PII, matching dev-server.ts's cloud path.
    log.debug(`Executing "${func.name}" in-process with args`);

    const { actionCallTimeoutMs, totalExecutionTimeoutMs } = deriveActionTimeouts(longPolling);

    // A timed-out execution is abandoned, not canceled — its fn() may keep running, so isCurrent()
    // gates both its $.Actions closure and the shared adapters against acting under a stale identity.
    const scope = executionEpoch.start();

    // A long-poll can legitimately outlast timeoutMs — pausing the timer while a call is in flight
    // and restarting it once all settle keeps real progress from being penalized while a genuine
    // hang still times out normally.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectTimeout: ((error: Error) => void) | undefined;
    let pendingActionCalls = 0;
    let absoluteTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    // Promise.race abandons a hung fn without cancelling it, so this closes its blocked scope instead.
    const blockedScopeController = new AbortController();
    const failWithTimeout = (message: string) => {
        concludeExecution();
        blockedScopeController.abort();
        const timeoutError = new Error(message);
        rejectTimeout?.(timeoutError);
    };

    const scheduleTimeout = () => {
        timer = setTimeout(() => {
            failWithTimeout(`Local execution of "${func.name}" timed out after ${timeoutMs}ms`);
        }, timeoutMs);
    };

    // Re-armed (not just set once) from each new $.Actions call below, so a function making
    // several sequential calls — each within its own actionCallTimeoutMs — isn't killed for
    // exceeding a ceiling sized for only one of them.
    const rearmAbsoluteTimeout = () => {
        clearTimeout(absoluteTimeoutTimer);
        absoluteTimeoutTimer = setTimeout(() => {
            failWithTimeout(
                `Local execution of "${func.name}" exceeded the absolute ${totalExecutionTimeoutMs}ms execution ceiling, regardless of any $.Actions call in flight.`,
            );
        }, totalExecutionTimeoutMs);
    };

    const guardedExecuteAction: ExecuteAction = async (fqn, inputs, connectionId) => {
        if (!scope.isCurrent()) {
            // Wording stays conclusion-neutral, not "timed out" — a concluded scope may have
            // ended for another reason.
            throw abandonedExecutionError(func.name, `run "${fqn}"`);
        }
        pendingActionCalls += 1;
        clearTimeout(timer);
        rearmAbsoluteTimeout();
        try {
            const actionCallPromise = executeAction(fqn, inputs, connectionId);
            return await withTimeout(
                actionCallPromise,
                actionCallTimeoutMs,
                `$.Actions call to "${fqn}"`,
            );
        } finally {
            pendingActionCalls -= 1;
            if (pendingActionCalls === 0 && scope.isCurrent()) {
                scheduleTimeout();
            }
        }
    };

    const concludeExecution = () => {
        scope.concludeIfCurrent();
    };

    // The preview response is the same context already available to cloud backend code, but it
    // belongs to a bootstrap invocation. The platform owns that context's safe-field contract;
    // this executor never merges its API/App keys or OAuth token. Target-invocation-owned values
    // are always replaced locally.
    const $: BackendGlobals = {
        ...runtimeContext,
        backendFunctionArgs: args,
        Actions: makeActionsProxy((fqn, call, actionDescription) =>
            invokeAction(
                guardedExecuteAction,
                fqn,
                call,
                func.allowedConnectionIds,
                actionDescription,
            ),
        ),
    };

    const dispatch: ExecutionDispatch = {
        executeAction: guardedExecuteAction,
        allowedConnectionIds: func.allowedConnectionIds,
        isAbandoned: () => !scope.isCurrent(),
        functionName: func.name,
        $,
    };

    const run = async (): Promise<BackendOutputs> => {
        // Wraps the whole body so a module-load failure also concludes the scope — otherwise
        // activeGeneration stays pinned to this execution until the next start() overwrites it.
        try {
            // Loads the module before installing $ and the SDK bridges, matching production's
            // ordering. A caller that already primed this entry passes the resolved module
            // directly, keeping loadModule's identity stable for the registration caches below.
            const mod =
                primedEntry ??
                (await loadCustomerModuleEntry(
                    loadModule,
                    func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX,
                ));
            const fn = mod[func.name];
            if (typeof fn !== 'function') {
                throw new Error(
                    `"${func.name}" is not a function exported from ${func.absolutePath}`,
                );
            }

            // Reinstalls the accessor if a prior execution's code deleted globalThis.$ — only
            // closes the gap between executions, not a mid-flight deletion by a concurrent one.
            ensureDollarAccessorInstalled();

            // Scopes globalThis.$ and the dispatch info to this call's own async continuation chain.
            return await backendGlobalsContext.run({ value: $ }, () =>
                executionDispatchContext.run(dispatch, async () => {
                    const rejectIfAbandoned = () => {
                        if (!scope.isCurrent()) {
                            throw new Error(
                                `Execution of "${func.name}" was abandoned after timing out before it could start.`,
                            );
                        }
                    };
                    // The module load above can already have crossed the timeout.
                    rejectIfAbandoned();
                    // Both adapters are stable and idempotent to re-register, so no coordination is needed between them or across executions.
                    const actionCatalogRegistration = registerActionCatalogIfInstalled(
                        loadModule,
                        projectRoot,
                        timeoutMs,
                    );
                    const backendRuntimeRegistration = registerBackendRuntimeIfInstalled(
                        loadModule,
                        projectRoot,
                        timeoutMs,
                    );
                    await Promise.all([actionCatalogRegistration, backendRuntimeRegistration]);
                    // Registration's loadModule() calls can take long enough to cross the timeout,
                    // and the customer function must never run once abandoned.
                    rejectIfAbandoned();
                    // assertJsonSerializable runs inside runBlocked's callback, not after, since its toJSON()/getter calls must run while access is still blocked.
                    const data = await runBlocked(
                        async () => {
                            const result = await callBackendFunction(() => fn(...args));
                            return assertJsonSerializable(result, func);
                        },
                        { signal: blockedScopeController.signal },
                    );
                    return { data };
                }),
            );
        } finally {
            // However this execution ends, mark it concluded so any further dispatch through it — direct or via the shared adapters — is rejected.
            concludeExecution();
        }
    };

    const timeout = new Promise<never>((_resolve, reject) => {
        rejectTimeout = reject;
        scheduleTimeout();
    });

    rearmAbsoluteTimeout();

    // Racing the timeout only stops the caller from waiting — run() keeps executing afterward,
    // since true cancellation would require terminating a Worker thread.
    const runPromise = run();
    // Lets the handler below tell an abandoned rejection from an ordinary one.
    let raceSettled = false;
    // Nothing awaits runPromise once the timeout wins, so a later rejection would otherwise
    // crash as unhandled — logged instead so a slow real failure stays diagnosable.
    runPromise.catch((error: unknown) => {
        if (!raceSettled) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        log.debug(`"${func.name}" failed after its caller had already stopped waiting: ${message}`);
    });

    try {
        return await Promise.race([runPromise, timeout]);
    } finally {
        raceSettled = true;
        clearTimeout(timer);
        clearTimeout(absoluteTimeoutTimer);
    }
}
