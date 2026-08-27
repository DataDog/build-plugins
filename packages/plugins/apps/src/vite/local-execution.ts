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

/** Boxed so a customer module assigning to `globalThis.$` (e.g. importing `zx/globals`, which does exactly this) mutates only its own execution's box, never a concurrent or zombie execution's. */
type BackendGlobalsBox = { value: unknown };

/** Scopes `globalThis.$` per execution via AsyncLocalStorage, not a plain mutable property, so a zombie execution's late "fresh" `globalThis.$` read resolves to its own `$`, never a newer execution's identity/`allowedConnectionIds`. */
const backendGlobalsContext = new AsyncLocalStorage<BackendGlobalsBox>();

/** Whether something (e.g. `zx/globals`, which assigns `globalThis.$` at its own import time) installed `$` before this module's own accessor below — distinguishes that legitimate passthrough from a customer module reaching for `$` during its own top-level evaluation, which has no such prior value and should fail the same way production does. */
const hadPreexistingDollar = Reflect.has(globalThis, '$');

/** Marks specifically the window where a customer module's own top-level code (import-time side effects, evaluated before this execution's box exists) is loading — narrower than "no box on the call stack," which is also true genuinely between executions, where the old undefined-returning fallback below is still correct. Carries its own mutable box (not just a boolean marker) so a top-level write during this window — e.g. `zx/globals`, which assigns `globalThis.$` at its own import time — lands in a box scoped to *this* module's own load, not the shared `globalDollarOutsideExecution` slot a later, unrelated execution's own top-level load would also read from. */
const customerModuleLoadContext = new AsyncLocalStorage<{ assigned: boolean; value: unknown }>();

/** Backs `globalThis.$` for reads/writes that happen with no execution box on the AsyncLocalStorage-scoped call stack (e.g. this module's own import-time state) — an ordinary mutable slot, since there's no per-execution box to isolate it into. Seeded from any `$` already installed before this module loaded, so installing the accessor below doesn't silently discard a legitimate `zx/globals`-style passthrough. */
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
        // Matches production: a customer module's own top-level evaluation runs before production installs $, so referencing it fails loudly there too, instead of silently resolving to undefined.
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
        // Scoped to this one module load, not the shared globalDollarOutsideExecution slot — otherwise a customer module's own top-level write (e.g. zx/globals) would leak into every later, unrelated execution's own top-level load instead of staying local to this one.
        loadBox.assigned = true;
        loadBox.value = value;
        return;
    }
    globalDollarOutsideExecution = value;
}

ensureDollarAccessorInstalled();

/** What the stable, once-ever-registered action-catalog/apps-backend adapters (below) need to dispatch a typed-wrapper call to the execution that's actually on the AsyncLocalStorage-scoped call stack — kept out of `BackendGlobals` since that object is also `globalThis.$`, directly visible to customer code. */
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

/** Bounds a single `$.Actions` call while it's exempt from the hang-detection timer above (see `guardedExecuteAction`). `doRequest` attaches no abort signal or deadline of its own, so an in-flight call that never settles would otherwise wedge this execution — and, since local executions are serialized, every request queued behind it — forever. Set generously past `pollQueryExecution`'s own worst-case long-poll budget (10 retries at up to ~30s each) so a legitimate slow action is never cut off. */
const MAX_ACTION_CALL_TIMEOUT_MS = 10 * 60_000;

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

/** Shared validation for both $.Actions entry points (the raw proxy and the action-catalog typed-wrapper dispatcher) — extracted so a future change to this contract can't be applied to one and missed on the other, the exact gap that let the action-catalog path silently forward `inputs: undefined`. */
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

/** Local executions are serialized since a customer function deleting `globalThis.$` (see `ensureDollarAccessorInstalled`'s own doc comment) would otherwise break `$` access for any other execution concurrently mid-flight, with no way to recover until that other execution's own next run reinstalls the accessor. */
let queueTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = queueTail.then(run);
    queueTail = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

/** One shared guard across all local executions — `enqueue` only serializes each execution's *start*, not its full lifetime: a timed-out execution's `fn()` keeps running in the background (see the "abandoned, not canceled" comment below) while the queue advances and a new execution starts, so the two genuinely overlap. This guard's generation counter is what rejects the abandoned execution's late `$.Actions`/adapter dispatch during that overlap window, not a redundant backstop for something serialization already prevents. */
const executionEpoch = createEpochGuard();

/** Resolves a nested property path (e.g. $.Actions.slack.chat.postMessage) to a callable that invokes `executeAction` directly — no IPC needed since there's no separate process to cross. */
function makeActionsProxy(
    executeAction: ExecuteAction,
    allowedConnectionIds: string[],
    pathParts: string[] = [],
): unknown {
    return new Proxy(function () {}, {
        get(_target, prop) {
            // A customer function that returns an un-invoked reference (e.g. $.Actions.foo.bar without the trailing call) must not be mistaken for a thenable or a custom-serializable object — Promise's resolution protocol probes .then(), and JSON.stringify (assertJsonSerializable) probes .toJSON(); either probe calling into the async apply() below would hang until timeout or leak an unhandled rejection instead of surfacing assertJsonSerializable's clear "can't be serialized" error.
            if (prop === 'then' || prop === 'toJSON') {
                return undefined;
            }
            return makeActionsProxy(
                executeAction,
                allowedConnectionIds,
                pathParts.concat(String(prop)),
            );
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

/** Bounds a promise that would otherwise be able to hang forever — a registration's underlying `loadModule` call (a broken/circular module graph, not just a slow one), or a `$.Actions` call whose transport attaches no deadline of its own — so it rejects instead of leaving its caller waiting indefinitely. Doesn't cancel the underlying promise (not possible for a plain `Promise`), so it still runs its side effects late if it eventually does settle; see each call site's own doc comment for why that's harmless there. `label` is the full, already-attributed subject of the timeout message (e.g. `` `Loading ${specifier}` ``), not appended to a fixed prefix, so it reads naturally for both a load and an action call. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

/** Keyed by `loadModule` identity, not a bare module-level flag — a real dev server reuses the same Vite `ssrLoadModule` for its whole lifetime (giving true once-ever registration), while each test constructs its own `loadModule` closure (keeping tests isolated from each other's registration state). A rejection is evicted so the next execution retries, rather than permanently poisoning every later execution with one transient load failure — including a load that never settles at all, since `withTimeout` below turns that into a rejection too. */
const actionCatalogRegistrations = new WeakMap<LoadModule, Promise<void>>();

/** No-ops if @datadog/action-catalog isn't installed — re-checked on every call, uncached, so installing the package mid-session (without restarting the dev server) is picked up on the very next execution instead of staying permanently no-op. Once installed, registers ONE stable dispatcher for the process lifetime — it reads `executionDispatchContext.getStore()` at call time to resolve whichever execution is actually on the AsyncLocalStorage-scoped call stack, so a zombie execution's typed-wrapper call can never be routed through a newer execution's identity/allowedConnectionIds just because that execution's own registration is the one currently live. */
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

/** Mirrors `actionCatalogRegistrations` — see its doc comment for why keying on `loadModule` identity is safe across both real dev-server reuse and per-test isolation, and for why an unbounded load is treated as a rejection via `withTimeout`. */
const backendRuntimeRegistrations = new WeakMap<LoadModule, Promise<void>>();

/** No-ops if @datadog/apps-backend isn't installed — re-checked on every call, uncached, so installing the package mid-session (without restarting the dev server) is picked up on the very next execution instead of staying permanently no-op. Once installed, registers ONE stable runtime Proxy for the process lifetime — every accessor call resolves whichever execution's `$` is on the AsyncLocalStorage-scoped call stack (or rejects if that execution has concluded), rather than a runtime bound to a specific execution's `$` at registration time. */
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
    // Built once per execution (cached by dispatch identity), not once per accessor call — dispatch.$ is fixed for its whole execution, so rebuilding on every property access wasted work without changing the result.
    const runtimeByDispatch = new WeakMap<ExecutionDispatch, unknown>();
    // Forwards to whatever shape the real runtime's own property has — a nested namespace (e.g. `.user.getExecutionUser()`) as well as a flat method — rather than assuming every property is itself a callable, which the real @datadog/apps-backend runtime is not.
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
                // A flat method (e.g. .getExecutionUser()) reads its own internal state via
                // `this` — returning it unbound would call it with `this` bound to this Proxy's
                // empty target instead of the real runtime object. A nested namespace property
                // (e.g. .user) is returned as-is; its own methods keep correct `this` since the
                // real sub-object, not this proxy, is what ends up receiving the call.
                return typeof value === 'function' ? value.bind(runtime) : value;
            },
        },
    );
    setBackend(backendRuntimeProxy);
}

/** Rejects a non-JSON-serializable result (circular reference/`BigInt`, a bare function/`Symbol` that `JSON.stringify` silently drops, or a `Map`/`Set` that it silently flattens to `{}` since neither exposes its entries as own enumerable properties) here with a clear error, instead of failing downstream when serialized for the HTTP response. */
// Thrown from inside assertJsonSerializable's replacer to carry an already-specific, attributed message straight through the outer catch below, rather than being re-wrapped in its generic "can't be serialized" fallback.
class UnsupportedJsonValueError extends Error {}

function assertJsonSerializable(result: unknown, func: BackendFunction): unknown {
    let serialized: string | undefined;
    try {
        // A replacer runs on every key/value pair JSON.stringify visits, root included, so a Map/Set/non-finite number/function/Symbol/undefined nested arbitrarily deep inside the result (e.g. `{ data: new Map() }` or `{ status: 'ok', callback: () => {} }`) is caught the same way a top-level one is — JSON.stringify would otherwise silently flatten, convert, omit, or null out the offending value instead of throwing. The root call is excluded from the function/Symbol/undefined check below since a root result of exactly one of those types is a distinct, allowed case handled after this call via the `serialized === undefined` branch. Tracked via a one-shot flag rather than `key === ''`, since a real property can also be named the empty string (`{ '': ... }`) and isn't the root.
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

    // A timed-out execution is abandoned, not canceled — its fn() may keep running and must not act under a newer execution's identity. The scope's isCurrent() is checked both directly (this execution's own captured `$.Actions` closure) and via `executionDispatchContext` (the stable, shared action-catalog/apps-backend adapters resolve the CALLING execution's own dispatch info from AsyncLocalStorage at call time, so a zombie's call can never be serviced by whichever execution's registration happens to be live).
    const scope = executionEpoch.start();

    // `executeAction`'s own long-poll (dev-server.ts's pollQueryExecution)
    // can legitimately take far longer than `timeoutMs` on its own — that's
    // time spent waiting on a real network round trip, not evidence the
    // customer function itself has hung. Pausing the hang-detection timer
    // while at least one call is in flight, and giving it a fresh
    // `timeoutMs` window once every in-flight call has settled, means a
    // function that keeps making real progress via `$.Actions` is never
    // penalized for it, while a function that genuinely hangs (with no
    // `$.Actions` call in flight) still times out at the same `timeoutMs`
    // it always did.
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
            // A concluded execution's scope stays concluded forever, not just "not the latest," so the wording stays conclusion-neutral rather than claiming a timeout that may not have happened.
            return Promise.reject(
                new Error(
                    `Execution of "${func.name}" already concluded; refusing to run ` +
                        `"${fqn}" as this stale execution to avoid using a newer execution's identity.`,
                ),
            );
        }
        pendingActionCalls += 1;
        clearTimeout(timer);
        try {
            return await withTimeout(
                executeAction(fqn, inputs, connectionId),
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
        // Loads and evaluates the customer's module BEFORE installing $ and the SDK bridges below, matching production's own ordering (backend/virtual-entry.ts statically imports the customer module before its wrapper installs $ and the SDK bridges) — code that reaches for $ or a typed action during its own top-level evaluation fails the same way locally as it would in Datadog, instead of silently succeeding against bindings production wouldn't have installed yet.
        const mod = await customerModuleLoadContext.run({ assigned: false, value: undefined }, () =>
            loadModule(func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX),
        );
        const fn = mod[func.name];
        if (typeof fn !== 'function') {
            throw new Error(`"${func.name}" is not a function exported from ${func.absolutePath}`);
        }

        // Reinstalls the accessor if a prior execution's customer code deleted globalThis.$ — otherwise this execution's box below would be unreachable through globalThis.$ for its whole lifetime, not just for whichever execution did the deleting. Only closes the gap between executions: a deletion made by one execution WHILE another is still concurrently running (its fn() hasn't returned yet) can't be recovered mid-flight — there is no way to intercept a property access on a since-deleted globalThis property without wrapping the global object itself, which isn't possible for a live, already-running process. That narrower case is accepted as-is.
        ensureDollarAccessorInstalled();

        // Scopes globalThis.$ and the action-catalog/apps-backend dispatch info to this call's own async continuation chain — see backendGlobalsContext's and executionDispatchContext's doc comments.
        return backendGlobalsContext.run({ value: $ }, () =>
            executionDispatchContext.run(dispatch, async () => {
                try {
                    // The action-catalog/apps-backend adapters are stable and idempotent to re-register — see their own doc comments — so no coordination is needed between the two registrations or across executions.
                    await Promise.all([
                        registerActionCatalogIfInstalled(loadModule, projectRoot, timeoutMs),
                        registerBackendRuntimeIfInstalled(loadModule, projectRoot, timeoutMs),
                    ]);

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

    const timeout = new Promise<never>((_resolve, reject) => {
        rejectTimeout = reject;
        scheduleTimeout();
    });

    // Racing against the timeout only stops the caller from waiting — run() keeps executing in-process afterward, so a customer function that resumes post-timeout can still fire real $.Actions side effects. True cancellation requires terminating a Worker thread, not possible for in-process execution.
    const runPromise = run();
    // Set once the race below has settled, so the handler right after can tell a genuinely abandoned rejection (caller already gone) from an ordinary one the caller's own `await Promise.race` is about to receive normally.
    let raceSettled = false;
    // Nothing awaits runPromise once the timeout has already settled the race — an unhandled rejection from it later would otherwise crash the whole dev server process. Logged (not swallowed silently) so a slow real failure is still diagnosable after the caller has already moved on.
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
