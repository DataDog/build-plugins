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

/** Scopes vite/index.ts's suffixed-subgraph tracking (see its `resolveId` hook) to one entry's own module-graph traversal, run alongside `customerModuleLoadContext` below — every caller that loads a customer entry, real dev-server request or test harness alike, funnels through `loadCustomerModuleEntry`, so scoping here (rather than wherever a particular `loadModule` happens to be constructed) reaches every path uniformly. Without this, a single process-wide Set would let a helper module reached by one local execution's traversal stay marked for the dev server's whole lifetime, so a later unrelated SSR resolution of the same helper would inherit the marker and serve real backend code instead of the frontend RPC-proxy stub. */
export const localExecutionResolutionContext = new AsyncLocalStorage<Set<string>>();

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
        // Matches production: $ isn't a global property at all until main() assigns it, so an
        // unresolvable `$` reads as undefined rather than throwing (per typeof's spec-defined
        // behavior on unresolvable references) — returning undefined here keeps that true even
        // though $ is a real accessor property locally, not a genuinely absent one.
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

export const DEFAULT_TIMEOUT_MS = 10_000;

/** Bounds a single `$.Actions` call while it's exempt from the hang-detection timer (see `guardedExecuteAction`) — `doRequest` has no deadline of its own, so an unsettled call would wedge this execution, and every serialized request queued behind it, forever. Set generously past `pollQueryExecution`'s worst-case long-poll budget (10 retries × ~30s) so a legitimately slow action is never cut off. */
const MAX_ACTION_CALL_TIMEOUT_MS = 10 * 60_000;

/** Absolute ceiling on one execution's wall-clock time, independent of `pendingActionCalls`'s pause-and-extend mechanism (see `guardedExecuteAction`) — that mechanism can't tell a function genuinely awaiting a slow `$.Actions` call from one that fired-and-forgot a call and then hung on something else, so an unawaited call can mask a real hang for up to `MAX_ACTION_CALL_TIMEOUT_MS`. Set just above `pollQueryExecution`'s worst case (~300s) so one legitimate slow call still finishes, bounding the masked-hang case to ~6 minutes rather than the full 10 — going lower would start killing real in-progress calls instead of just hangs. */
const MAX_TOTAL_EXECUTION_TIMEOUT_MS = 6 * 60_000;

/** Loads a module by specifier, resolved against the customer's own project rather than build-plugins' dependency tree — the dev server passes its Vite instance's `ssrLoadModule` here. */
export type LoadModule = (specifier: string) => Promise<Record<string, unknown>>;

/** Loads a customer module under the same top-level-evaluation `$`-scoping `runScriptLocally` uses (see `customerModuleLoadContext`) — for callers like dev-server.ts's priming load that trigger real top-level evaluation ahead of `executeScriptLocally`. */
export function loadCustomerModuleEntry(
    loadModule: LoadModule,
    entrySpecifier: string,
): Promise<Record<string, unknown>> {
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

// Shared wording for the "no longer current" rejection at every call site that checks execution abandonment (a direct $.Actions call, the action-catalog dispatcher, and the apps-backend accessor) — a concluded scope stays concluded forever, not just "not the latest", so refusing to act under its identity applies uniformly regardless of entry point.
function abandonedExecutionError(functionName: string, refusedAction: string): Error {
    return new Error(
        `Execution of "${functionName}" already concluded; refusing to ${refusedAction} ` +
            `as this stale execution to avoid using a newer execution's identity.`,
    );
}

/** One shared guard across all executions — `enqueue` only serializes each execution's *start*; a timed-out `fn()` keeps running afterward (see "abandoned, not canceled" below). `isCurrent()`'s cross-scope generation comparison is what rejects that zombie's later `$.Actions` dispatch, once a newer scope has taken over. Each scope's own `concludeIfCurrent()` is a separate, narrower guard: it only clears the shared generation if THIS scope is still the one active, so a scope's delayed cleanup can never clobber a newer scope that has already superseded it. */
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

/** Bounds a promise that could otherwise hang forever — a `loadModule` call against a broken/circular graph, or a `$.Actions` call with no deadline of its own — rejecting instead of leaving the caller waiting indefinitely. Doesn't cancel the underlying promise (not possible for a plain `Promise`), so late side effects can still fire if it eventually settles; see each call site for why that's harmless there. `label` is the full, already-attributed subject of the timeout message (e.g. `` `Loading ${specifier}` ``), not a suffix on a fixed prefix, so it reads naturally for both loads and action calls. */
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

/** Shared once-ever-registration wrapper for both adapters below: no-ops if uninstalled (re-checked uncached on every call, so a mid-session install is picked up on the very next execution), reuses the WeakMap-cached registration keyed by `loadModule` identity (true once-ever registration for a real dev server's reused `ssrLoadModule`, isolated per closure for each test), and evicts a rejection so the next execution retries instead of staying permanently poisoned. */
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

/** Registers ONE stable dispatcher for the process lifetime that reads `executionDispatchContext.getStore()` at call time, so a zombie's typed-wrapper call can never dispatch under a newer execution's identity just because that execution's registration is the one currently live. */
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
        const { inputs, connectionId } = validateActionCall(
            call,
            dispatch.allowedConnectionIds,
            `"${actionId}"`,
        );
        return dispatch.executeAction(actionId, inputs, connectionId);
    });
}

/** Mirrors `actionCatalogRegistrations` — see `registerOnceIfInstalled`'s doc comment. */
const backendRuntimeRegistrations = new WeakMap<LoadModule, Promise<void>>();

/** Registers ONE stable runtime Proxy for the process lifetime that resolves whichever execution's `$` is live on the AsyncLocalStorage call stack, rather than binding to one execution's `$` at registration time. */
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

/** Rejects a non-JSON-serializable result (circular reference, `BigInt`, a dropped function/`Symbol`, a `Map`/`Set` flattened to `{}`) here with a clear error, instead of failing downstream when serialized for the HTTP response. */
// Lets the replacer's already-specific message pass through the outer catch below unwrapped, instead of being replaced by its generic fallback.
class UnsupportedJsonValueError extends Error {}

/** `JSON.stringify`'s replacer never runs for a symbol-KEYED property (only symbol-valued ones under a string key) — it silently omits them with no callback at all, so they need their own recursive check. */
function findSymbolKeyedObject(value: unknown, visited: Set<object>): boolean {
    if (typeof value !== 'object' || value === null || visited.has(value)) {
        return false;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
        return true;
    }
    visited.add(value);
    return Object.values(value).some((child) => findSymbolKeyedObject(child, visited));
}

function assertJsonSerializable(result: unknown, func: BackendFunction): unknown {
    if (findSymbolKeyedObject(result, new Set())) {
        throw new Error(
            `Local execution of "${func.name}" returned a value with a Symbol-keyed property, which JSON.stringify silently drops instead of serializing — return a plain JSON-compatible value instead.`,
        );
    }
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

/**
 * Test-only entry point: exercises `runScriptLocally`'s queue and execution behavior directly,
 * with priming already done (via `primedEntry`) rather than performed inside this call. Nothing
 * in production calls this — `dev-server.ts` always goes through `executeColdActionLocally`,
 * which primes and resolves connection IDs inside the SAME `enqueue()` call this function makes,
 * a guarantee this signature can't provide (a caller priming beforehand does so outside any
 * queue). Kept as its own function, rather than merged into `executeColdActionLocally`, since
 * folding priming into this signature would mean changing what `primedEntry` means for the ~90
 * tests that call this directly to exercise `runScriptLocally`'s behavior in isolation.
 */
export async function executeScriptLocally(
    func: BackendFunction,
    projectRoot: string,
    args: unknown[],
    executeAction: ExecuteAction,
    loadModule: LoadModule,
    log: Logger,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    primedEntry?: Record<string, unknown>,
): Promise<BackendOutputs> {
    return enqueue(() =>
        runScriptLocally(
            func,
            projectRoot,
            args,
            executeAction,
            loadModule,
            log,
            timeoutMs,
            primedEntry,
        ),
    );
}

/**
 * The dev server's actual entry point for a cold (not-yet-known-allowlisted) function: primes
 * the entry, collects its real `allowedConnectionIds` from the now-populated module graph, then
 * runs it — all inside the SAME `enqueue()` call as the execution itself. Priming runs real
 * top-level customer code (see `loadCustomerModuleEntry`), so doing it outside this queue would
 * let two concurrent requests for two different cold functions evaluate their top-level code in
 * genuine parallel, silently violating the "executions never interleave" guarantee `enqueue`
 * exists to provide. Calls `runScriptLocally` directly (not the exported `executeScriptLocally`)
 * to avoid enqueueing twice, which would deadlock — `enqueue` is a plain promise chain, not a
 * reentrant lock, so a nested call would wait on its own still-pending outer call forever.
 *
 * The `withTimeout` calls below bound each step but don't cancel it — if priming or connection-ID
 * resolution legitimately exceeds `timeoutMs`, this call's own `enqueue()` slot settles (rejects)
 * and the queue advances to the next request while the real work keeps running in the background.
 * That's the same "abandoned, not canceled" trade-off this file already accepts for the
 * execution phase itself (see `executionEpoch` above) — extended here to priming because there's
 * no real cancellation available for `loadModule`/`collectModuleGraphFromServer`, and blocking the
 * queue until the abandoned call settles would mean one slow cold-start freezes every other
 * function's dev loop, a worse outcome for the fast-dev-loop goal than the narrow interleaving
 * risk this accepts instead.
 */
export async function executeColdActionLocally(
    func: BackendFunction,
    projectRoot: string,
    args: unknown[],
    executeAction: ExecuteAction,
    loadModule: LoadModule,
    getAllowedConnectionIds: (entryId: string) => Promise<string[]>,
    log: Logger,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BackendOutputs> {
    const displayName = `${func.relativePath}/${func.name}`;
    return enqueue(async () => {
        // The bundling collector is what normally populates func.allowedConnectionIds, but this
        // path skips bundling — priming the entry through Vite's moduleGraph first (see
        // collectModuleGraphFromServer) is what makes the allowlist reflect the function's real
        // imports instead of staying empty. Each step below needs its own bound independent of
        // runScriptLocally's own hang-detection timeout, which only starts once its body begins.
        const entrySpecifier = func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX;
        const primingPromise = loadCustomerModuleEntry(loadModule, entrySpecifier);
        const primedEntry = await withTimeout(
            primingPromise,
            timeoutMs,
            `Loading "${displayName}"`,
        );
        const connectionIdsPromise = getAllowedConnectionIds(func.absolutePath);
        const allowedConnectionIds = await withTimeout(
            connectionIdsPromise,
            timeoutMs,
            `Resolving allowed connections for "${displayName}"`,
        );
        return runScriptLocally(
            { ...func, allowedConnectionIds },
            projectRoot,
            args,
            executeAction,
            loadModule,
            log,
            timeoutMs,
            primedEntry,
        );
    });
}

async function runScriptLocally(
    func: BackendFunction,
    projectRoot: string,
    args: unknown[],
    executeAction: ExecuteAction,
    loadModule: LoadModule,
    log: Logger,
    timeoutMs: number,
    primedEntry?: Record<string, unknown>,
): Promise<BackendOutputs> {
    // Never log the args themselves — they may carry secrets/PII, matching dev-server.ts's cloud path.
    log.debug(`Executing "${func.name}" in-process with args`);

    // A timed-out execution is abandoned, not canceled — its fn() may keep running and must not act under a newer execution's identity. isCurrent() gates both this execution's own captured `$.Actions` closure and the shared adapters, which resolve the calling execution's dispatch from AsyncLocalStorage rather than whichever registration is currently live.
    const scope = executionEpoch.start();

    // `executeAction`'s long-poll (dev-server.ts's pollQueryExecution) can legitimately outlast
    // `timeoutMs` — that's network wait, not a hung customer function. Pausing the hang-detection
    // timer while a call is in flight, and giving a fresh `timeoutMs` window once all in-flight
    // calls settle, means real `$.Actions` progress is never penalized, while a genuine hang (no
    // call in flight) still times out at the usual `timeoutMs`.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectTimeout: ((error: Error) => void) | undefined;
    let pendingActionCalls = 0;

    const scheduleTimeout = () => {
        timer = setTimeout(() => {
            concludeExecution();
            rejectTimeout?.(
                new Error(`Local execution of "${func.name}" timed out after ${timeoutMs}ms`),
            );
        }, timeoutMs);
    };

    const guardedExecuteAction: ExecuteAction = async (fqn, inputs, connectionId) => {
        if (!scope.isCurrent()) {
            // A concluded scope stays concluded forever, not just "not the latest" — the wording stays conclusion-neutral rather than claiming a timeout that may not have happened.
            throw abandonedExecutionError(func.name, `run "${fqn}"`);
        }
        pendingActionCalls += 1;
        clearTimeout(timer);
        try {
            const actionCallPromise = executeAction(fqn, inputs, connectionId);
            return await withTimeout(
                actionCallPromise,
                MAX_ACTION_CALL_TIMEOUT_MS,
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
        // Wraps the whole body, not just the customer-function call below, so a failure while loading/resolving the module (e.g. loadModule rejecting, or the export not being a function) also concludes the scope — otherwise the epoch guard's cross-scope supersession never runs for this execution, leaving activeGeneration pinned to it until the next start() overwrites it.
        try {
            // Loads and evaluates the customer's module BEFORE installing $ and the SDK bridges below, matching production's own ordering (backend/virtual-entry.ts statically imports the customer module before its wrapper installs $ and the SDK bridges) — code that reaches for $ or a typed action during its own top-level evaluation fails the same way locally as it would in Datadog, instead of silently succeeding against bindings production wouldn't have installed yet.
            // A caller that already primed this same entry (e.g. dev-server.ts's own module-graph
            // priming load) passes the resolved module directly here instead of making `loadModule`
            // resolve it a second time — keeping `loadModule` itself unwrapped and stable, since the
            // registration caches below key off its identity, not off which entry was last loaded.
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

            // Reinstalls the accessor if a prior execution's customer code deleted globalThis.$, so this execution's box stays reachable. Only closes the gap between executions — a deletion made mid-flight by a still-running concurrent execution can't be recovered, since there's no way to intercept access on a since-deleted global property; that narrower case is accepted as-is.
            ensureDollarAccessorInstalled();

            // Scopes globalThis.$ and the dispatch info to this call's own async continuation chain.
            return await backendGlobalsContext.run({ value: $ }, () =>
                executionDispatchContext.run(dispatch, async () => {
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

    // Fires regardless of pendingActionCalls, unlike the pause-and-extend timeout above — bounds the worst case of a fire-and-forget $.Actions call masking an unrelated hang to MAX_TOTAL_EXECUTION_TIMEOUT_MS instead of the per-call MAX_ACTION_CALL_TIMEOUT_MS.
    const absoluteTimeoutTimer = setTimeout(() => {
        concludeExecution();
        rejectTimeout?.(
            new Error(
                `Local execution of "${func.name}" exceeded the absolute ${MAX_TOTAL_EXECUTION_TIMEOUT_MS}ms execution ceiling, regardless of any $.Actions call in flight.`,
            ),
        );
    }, MAX_TOTAL_EXECUTION_TIMEOUT_MS);

    // Racing against the timeout only stops the caller from waiting — run() keeps executing in-process afterward, so a customer function that resumes post-timeout can still fire real $.Actions side effects. True cancellation requires terminating a Worker thread, not possible for in-process execution.
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
        clearTimeout(absoluteTimeoutTimer);
    }
}
