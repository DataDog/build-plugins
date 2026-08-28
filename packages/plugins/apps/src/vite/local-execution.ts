// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global Proxy, globalThis */

/** Executes a backend function's file directly in-process inside the Vite dev server, mirroring executeScriptViaDatadog's `BackendOutputs` contract in dev-server.ts as a drop-in alternate implementation. */

import type { Logger } from '@dd/core/types';
import { AsyncLocalStorage } from 'node:async_hooks';

import { isActionCatalogInstalled, isDatadogAppsBackendInstalled } from '../backend/shared';
import type { BackendFunction, BackendOutputs } from '../backend/types';
import { LOCAL_EXECUTION_LOAD_SUFFIX } from '../constants';

import { createEpochGuard } from './execution-epoch';

type BackendGlobals = {
    backendFunctionArgs: unknown[];
    Actions: unknown;
    Source: ReturnType<typeof makeLocalDevSource>;
};

/** Boxed so a customer module assigning to `globalThis.$` (e.g. `zx/globals`) mutates only its own execution's box, never a concurrent or zombie execution's. */
type BackendGlobalsBox = { value: unknown };

/** Scopes `globalThis.$` per execution via AsyncLocalStorage so a zombie execution's late "fresh" read resolves to its own `$`, never a newer execution's identity. */
const backendGlobalsContext = new AsyncLocalStorage<BackendGlobalsBox>();

/** Whether `$` was installed (e.g. by `zx/globals`) before this module's own accessor below — distinguishes that legitimate passthrough from a customer module reaching for `$` with no prior value, which should fail like production does. */
const hadPreexistingDollar = Reflect.has(globalThis, '$');

/** Marks the window where a customer module's own top-level code is loading, narrower than "no execution box on the call stack" (also true between executions, where the undefined-returning fallback below is correct). Carries its own mutable box so a top-level `$` write (e.g. `zx/globals`) lands scoped to this module's own load, not the shared `globalDollarOutsideExecution` slot a later, unrelated load would also read from. */
const customerModuleLoadContext = new AsyncLocalStorage<{ assigned: boolean; value: unknown }>();

/** Backs `globalThis.$` outside any execution box (e.g. this module's own import-time state); seeded from any `$` already installed before this module loaded so the accessor below doesn't discard a legitimate `zx/globals`-style passthrough. */
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
        // Matches production, where a customer module's top-level evaluation also runs before $ is installed and fails loudly rather than resolving to undefined.
        throw new Error('No active local execution to resolve $ under.');
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
        // Scoped to this module load, not the shared globalDollarOutsideExecution slot — otherwise a top-level write (e.g. zx/globals) would leak into every later, unrelated load.
        loadBox.assigned = true;
        loadBox.value = value;
        return;
    }
    globalDollarOutsideExecution = value;
}

ensureDollarAccessorInstalled();

/** What the stable, once-ever-registered adapters below need to dispatch a call to whichever execution is on the AsyncLocalStorage call stack — kept out of `BackendGlobals` since that object is also `globalThis.$`, visible to customer code. */
type ExecutionDispatch = {
    executeAction: ExecuteAction;
    allowedConnectionIds: string[];
    isAbandoned: () => boolean;
    functionName: string;
    $: BackendGlobals;
};

/** Distinct from `backendGlobalsContext` so dispatch-only fields (the real `executeAction`, `allowedConnectionIds`) never leak onto `globalThis.$`. */
const executionDispatchContext = new AsyncLocalStorage<ExecutionDispatch>();

interface ActionCallArgs {
    inputs: Record<string, unknown>;
    connectionId?: string;
}

/** Narrows an unknown value enough to read named properties off it by key. */
function isIndexableRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Loads a module by specifier, resolved against the customer's own project rather than build-plugins' dependency tree — the dev server passes its Vite instance's `ssrLoadModule` here. */
export type LoadModule = (specifier: string) => Promise<Record<string, unknown>>;

/** Executes a real `$.Actions.foo.bar(...)` call; the dev server supplies the implementation using its own auth, so this module never holds or sees a credential itself. */
export type ExecuteAction = (
    fqn: string,
    inputs: unknown,
    connectionId: string | undefined,
) => Promise<unknown>;

/** Synthetic local-dev identity for `$.Source` — a fresh object per call, since customer code could otherwise mutate a shared singleton and corrupt every later execution's identity. */
function makeLocalDevSource() {
    return {
        initiator: { id: 'local-dev', orgId: 'local-dev-org' },
        runAsUser: { id: 'local-dev', orgId: 'local-dev-org' },
    };
}

/** Mirrors the cloud path's server-side allowedConnectionIds restriction, so local dev enforces the same connection scoping as production. */
function assertConnectionIdAllowed(
    connectionId: string | undefined,
    allowedConnectionIds: string[],
    actionDescription: string,
): void {
    if (connectionId !== undefined && !allowedConnectionIds.includes(connectionId)) {
        throw new Error(
            `Action ${actionDescription} used connection "${connectionId}", which is not in this function's allowed connections: [${allowedConnectionIds.join(', ')}]`,
        );
    }
}

/** Shared validation for both $.Actions entry points (raw proxy and action-catalog typed wrapper) — extracted so a contract change can't be applied to one path and missed on the other. */
function validateActionCall(
    call: Partial<ActionCallArgs>,
    allowedConnectionIds: string[],
    actionDescription: string,
): { inputs: Record<string, unknown>; connectionId: string | undefined } {
    const { inputs, connectionId } = call;
    if (typeof inputs !== 'object' || !inputs) {
        throw new Error(`Action ${actionDescription} must have an inputs field`);
    }
    assertConnectionIdAllowed(connectionId, allowedConnectionIds, actionDescription);
    return { inputs, connectionId };
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

/** One shared guard across all executions — `enqueue` only serializes each execution's *start*; a timed-out `fn()` keeps running afterward (see "abandoned, not canceled" below), so this guard's generation counter is what rejects that zombie's late dispatch during the overlap, not a redundant backstop. */
const executionEpoch = createEpochGuard();

/** Resolves a nested property path (e.g. $.Actions.slack.chat.postMessage) to a callable that invokes `executeAction` directly — no IPC needed since there's no separate process to cross. */
function makeActionsProxy(
    executeAction: ExecuteAction,
    allowedConnectionIds: string[],
    pathParts: string[] = [],
): unknown {
    return new Proxy(function () {}, {
        get(_target, prop) {
            // An un-invoked $.Actions.foo.bar reference must not be mistaken for a thenable (Promise probes .then()) or serializable (assertJsonSerializable probes .toJSON()) — either probe hitting apply() below would hang or leak a rejection instead of a clear error.
            if (prop === 'then' || prop === 'toJSON') {
                return undefined;
            }
            const nestedPathParts = pathParts.concat(String(prop));
            return makeActionsProxy(executeAction, allowedConnectionIds, nestedPathParts);
        },
        async apply(_target, _thisArg, args: unknown[]) {
            if (args.length === 0) {
                throw new Error(`No arguments provided to action $.Actions.${pathParts.join('.')}`);
            }
            const call: Partial<ActionCallArgs> = isIndexableRecord(args[0]) ? args[0] : {};
            const { inputs, connectionId } = validateActionCall(
                call,
                allowedConnectionIds,
                `$.Actions.${pathParts.join('.')}`,
            );
            const fqn = `com.datadoghq.${pathParts.join('.')}`;
            return executeAction(fqn, inputs, connectionId);
        },
    });
}

/** Bounds a registration's `loadModule` call so a load that never settles (a broken/circular module graph) rejects instead of leaving its cache entry pending forever — eviction-on-rejection below only fires once a promise settles. Can't cancel the underlying promise, so a load that eventually settles still runs its side effects late; see the registration functions for why that's harmless. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Loading ${what} timed out after ${timeoutMs}ms`));
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

/** Keyed by `loadModule` identity, not a module-level flag, so a real dev server's reused `ssrLoadModule` gets true once-ever registration while each test's own closure stays isolated. A rejection (including a load `withTimeout` turns into one) is evicted so the next execution retries instead of staying permanently poisoned. */
const actionCatalogRegistrations = new WeakMap<LoadModule, Promise<void>>();

/** No-ops if @datadog/action-catalog isn't installed — the check is re-run uncached on every call, so a mid-session install is picked up on the very next execution. Once installed, registers ONE stable dispatcher that reads `executionDispatchContext.getStore()` at call time, so a zombie's typed-wrapper call can never dispatch under a newer execution's identity just because that execution's registration is the one currently live. */
function registerActionCatalogIfInstalled(
    loadModule: LoadModule,
    projectRoot: string,
    timeoutMs: number,
): Promise<void> {
    if (!isActionCatalogInstalled(projectRoot)) {
        return Promise.resolve();
    }
    const existing = actionCatalogRegistrations.get(loadModule);
    if (existing) {
        return existing;
    }
    const registration = registerActionCatalogOnce(loadModule, timeoutMs).catch((err) => {
        actionCatalogRegistrations.delete(loadModule);
        throw err;
    });
    actionCatalogRegistrations.set(loadModule, registration);
    return registration;
}

async function registerActionCatalogOnce(loadModule: LoadModule, timeoutMs: number): Promise<void> {
    const loadPromise = loadModule('@datadog/action-catalog/action-execution');
    const mod = await withTimeout(
        loadPromise,
        timeoutMs,
        '@datadog/action-catalog/action-execution',
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
            throw new Error(
                `Execution of "${dispatch.functionName}" already concluded; refusing to run ` +
                    `"${actionId}" as this stale execution to avoid using a newer execution's identity.`,
            );
        }
        const call: Partial<ActionCallArgs> = isIndexableRecord(request) ? request : {};
        const { inputs, connectionId } = validateActionCall(
            call,
            dispatch.allowedConnectionIds,
            `"${actionId}"`,
        );
        return dispatch.executeAction(actionId, inputs, connectionId);
    });
}

/** Mirrors `actionCatalogRegistrations` — same keying and timeout-eviction rationale. */
const backendRuntimeRegistrations = new WeakMap<LoadModule, Promise<void>>();

/** Mirrors `registerActionCatalogIfInstalled`'s no-op/re-check/once-ever-registration behavior for @datadog/apps-backend; the registered runtime Proxy resolves whichever execution's `$` is live on the AsyncLocalStorage call stack, rather than binding to one execution's `$` at registration time. */
function registerBackendRuntimeIfInstalled(
    loadModule: LoadModule,
    projectRoot: string,
    timeoutMs: number,
): Promise<void> {
    if (!isDatadogAppsBackendInstalled(projectRoot)) {
        return Promise.resolve();
    }
    const existing = backendRuntimeRegistrations.get(loadModule);
    if (existing) {
        return existing;
    }
    const registration = registerBackendRuntimeOnce(loadModule, timeoutMs).catch((err) => {
        backendRuntimeRegistrations.delete(loadModule);
        throw err;
    });
    backendRuntimeRegistrations.set(loadModule, registration);
    return registration;
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
        '@datadog/apps-backend/runtime',
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
                    throw new Error(
                        `Execution of "${dispatch.functionName}" already concluded; ` +
                            `refusing to resolve a further apps-backend accessor under its identity.`,
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

/** Rejects a non-JSON-serializable result (circular reference, `BigInt`, a dropped function/`Symbol`, a `Map`/`Set` flattened to `{}`) here with a clear error, instead of failing downstream when serialized for the HTTP response. */
// Lets the replacer's already-specific message pass through the outer catch below unwrapped, instead of being replaced by its generic fallback.
class UnsupportedJsonValueError extends Error {}

function assertJsonSerializable(result: unknown, func: BackendFunction): unknown {
    let serialized: string | undefined;
    try {
        // A replacer visits every key/value pair including the root, so a disallowed value nested arbitrarily deep is caught the same way a top-level one is, instead of JSON.stringify silently flattening/converting/dropping it. The root is excluded from the function/Symbol/undefined check below (handled separately via `serialized === undefined`) and tracked with a one-shot flag, not `key === ''`, since a real property can itself be named `''`.
        let isRootCall = true;
        serialized = JSON.stringify(result, (key, value) => {
            const wasRootCall = isRootCall;
            isRootCall = false;
            if (value instanceof Map || value instanceof Set) {
                throw new UnsupportedJsonValueError(
                    `Local execution of "${func.name}" returned a ${value.constructor.name}${key ? ` (at "${key}")` : ''}, which JSON.stringify silently flattens to "{}" instead of serializing its entries — return a plain array or object instead.`,
                );
            }
            if (typeof value === 'number' && !Number.isFinite(value)) {
                throw new UnsupportedJsonValueError(
                    `Local execution of "${func.name}" returned ${value}${key ? ` (at "${key}")` : ''}, which JSON.stringify silently converts to "null" instead of throwing — return a finite number instead.`,
                );
            }
            if (
                !wasRootCall &&
                (typeof value === 'function' || typeof value === 'symbol' || value === undefined)
            ) {
                throw new UnsupportedJsonValueError(
                    `Local execution of "${func.name}" returned a ${typeof value} (at "${key}"), which JSON.stringify silently drops instead of serializing — return a plain JSON-compatible value instead.`,
                );
            }
            return value;
        });
    } catch (err) {
        if (err instanceof UnsupportedJsonValueError) {
            throw err;
        }
        throw new Error(
            `Local execution of "${func.name}" returned a value that can't be serialized to JSON: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }
    if (serialized === undefined) {
        if (result !== undefined) {
            throw new Error(
                `Local execution of "${func.name}" returned a ${typeof result} value, which JSON.stringify silently drops instead of serializing — return a plain JSON-compatible value instead.`,
            );
        }
        return undefined;
    }
    // Return the parsed-and-reserialized value, not the original — the caller serializes again for the HTTP response, and the original would invoke a custom toJSON() a second time.
    return JSON.parse(serialized);
}

/** `globalThis.$` and the action-catalog/apps-backend registrations above provide the same customer-visible bindings production's generated wrapper module sets up via text injection; serialized via `enqueue`. */
export async function executeScriptLocally(
    func: BackendFunction,
    projectRoot: string,
    args: unknown[],
    executeAction: ExecuteAction,
    loadModule: LoadModule,
    log: Logger,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BackendOutputs> {
    return enqueue(() =>
        runScriptLocally(func, projectRoot, args, executeAction, loadModule, log, timeoutMs),
    );
}

async function runScriptLocally(
    func: BackendFunction,
    projectRoot: string,
    args: unknown[],
    executeAction: ExecuteAction,
    loadModule: LoadModule,
    log: Logger,
    timeoutMs: number,
): Promise<BackendOutputs> {
    // Never log the args themselves — they may carry secrets/PII, matching dev-server.ts's cloud path.
    log.debug(`Executing "${func.name}" in-process with args`);

    // A timed-out execution is abandoned, not canceled — its fn() may keep running and must not act under a newer execution's identity. isCurrent() gates both this execution's own captured `$.Actions` closure and the shared adapters, which resolve the calling execution's dispatch from AsyncLocalStorage rather than whichever registration is currently live.
    const scope = executionEpoch.start();

    const guardedExecuteAction: ExecuteAction = (fqn, inputs, connectionId) => {
        if (!scope.isCurrent()) {
            // A concluded scope stays concluded forever, not just "not the latest" — the wording stays conclusion-neutral rather than claiming a timeout that may not have happened.
            return Promise.reject(
                new Error(
                    `Execution of "${func.name}" already concluded; refusing to run ` +
                        `"${fqn}" as this stale execution to avoid using a newer execution's identity.`,
                ),
            );
        }
        return executeAction(fqn, inputs, connectionId);
    };

    const concludeExecution = () => {
        scope.concludeIfCurrent();
    };

    const $ = {
        backendFunctionArgs: args,
        Actions: makeActionsProxy(guardedExecuteAction, func.allowedConnectionIds),
        Source: makeLocalDevSource(),
    };

    const dispatch: ExecutionDispatch = {
        executeAction: guardedExecuteAction,
        allowedConnectionIds: func.allowedConnectionIds,
        isAbandoned: () => !scope.isCurrent(),
        functionName: func.name,
        $,
    };

    const run = async (): Promise<BackendOutputs> => {
        // Loads and evaluates the customer's module BEFORE installing $ and the SDK bridges below, matching production's own ordering (backend/virtual-entry.ts statically imports the customer module before its wrapper installs $ and the SDK bridges) — code that reaches for $ or a typed action during its own top-level evaluation fails the same way locally as it would in Datadog, instead of silently succeeding against bindings production wouldn't have installed yet.
        const mod = await customerModuleLoadContext.run({ assigned: false, value: undefined }, () =>
            loadModule(func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX),
        );
        const fn = mod[func.name];
        if (typeof fn !== 'function') {
            throw new Error(`"${func.name}" is not a function exported from ${func.absolutePath}`);
        }

        // Reinstalls the accessor if a prior execution's customer code deleted globalThis.$, so this execution's box stays reachable. Only closes the gap between executions — a deletion made mid-flight by a still-running concurrent execution can't be recovered, since there's no way to intercept access on a since-deleted global property; that narrower case is accepted as-is.
        ensureDollarAccessorInstalled();

        // Scopes globalThis.$ and the dispatch info to this call's own async continuation chain.
        return backendGlobalsContext.run({ value: $ }, () =>
            executionDispatchContext.run(dispatch, async () => {
                try {
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

                    if (!scope.isCurrent()) {
                        // Already known-abandoned before the customer function was reached — no point invoking it now.
                        throw new Error(
                            `Execution of "${func.name}" was abandoned after timing out before it could start.`,
                        );
                    }
                    const result = await fn(...args);
                    return { data: assertJsonSerializable(result, func) };
                } finally {
                    // However this execution ends, mark it concluded so any further dispatch through it — direct or via the shared adapters — is rejected.
                    concludeExecution();
                }
            }),
        );
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            concludeExecution();
            reject(new Error(`Local execution of "${func.name}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });

    // Racing the timeout only stops the caller from waiting — run() keeps executing afterward, so a resumed customer function can still fire real $.Actions side effects; true cancellation would need a Worker thread, not possible in-process.
    const runPromise = run();
    // Set once the race settles, so the handler below can tell an abandoned rejection (caller already gone) from an ordinary one the caller is about to receive normally.
    let raceSettled = false;
    // Nothing awaits runPromise once the timeout wins the race, so a later rejection would otherwise crash the dev server as unhandled — logged instead so a slow real failure stays diagnosable.
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
    }
}
