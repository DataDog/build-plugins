// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global Proxy, globalThis */

/** Executes a backend function's file directly in-process inside the Vite dev server, mirroring executeScriptViaDatadog's `BackendOutputs` contract in dev-server.ts as a drop-in alternate implementation. */

import type { Logger } from '@dd/core/types';

import { isActionCatalogInstalled, isDatadogAppsBackendInstalled } from '../backend/shared';
import type { BackendFunction, BackendOutputs } from '../backend/types';
import { LOCAL_EXECUTION_LOAD_SUFFIX } from '../constants';

interface ActionCallArgs {
    inputs: Record<string, unknown>;
    connectionId?: string;
}

/** Narrows an unknown value enough to read named properties off it by key. */
function isIndexableRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** `globalThis.$` is a runtime-only property TypeScript's built-in `typeof globalThis` has no way to know about — reading it needs one assertion, centralized here instead of repeated inline at each call site. */
function getGlobalDollar(): unknown {
    return (globalThis as Record<string, unknown>).$;
}

/** `Object.assign`'s signature doesn't require its source object's keys to already exist on the target, so this installs `$` without asserting `globalThis`'s type. */
function setGlobalDollar(value: unknown): void {
    Object.assign(globalThis, { $: value });
}

function deleteGlobalDollar(): void {
    Reflect.deleteProperty(globalThis, '$');
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

/** Resolves a nested property path (e.g. $.Actions.slack.chat.postMessage) to a callable that invokes `executeAction` directly — no IPC needed since there's no separate process to cross. */
function makeActionsProxy(
    executeAction: ExecuteAction,
    allowedConnectionIds: string[],
    pathParts: string[] = [],
): unknown {
    return new Proxy(function () {}, {
        get(_target, prop) {
            // A customer function that returns an un-invoked reference (e.g. $.Actions.foo.bar without the trailing call) must not be treated as a thenable — Promise's resolution protocol would call .then() on it and hang until the timeout, since apply() below never settles it.
            if (prop === 'then') {
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

/** No-ops if @datadog/action-catalog isn't installed; checks `isActionCatalogInstalled` up front rather than catching a load failure, since `loadModule` doesn't guarantee an error code for a missing bare specifier. */
async function registerActionCatalogIfInstalled(
    loadModule: LoadModule,
    projectRoot: string,
    executeAction: ExecuteAction,
    allowedConnectionIds: string[],
): Promise<void> {
    if (!isActionCatalogInstalled(projectRoot)) {
        return;
    }
    const mod = await loadModule('@datadog/action-catalog/action-execution');
    const setExecuteActionImplementation = mod.setExecuteActionImplementation;
    if (typeof setExecuteActionImplementation !== 'function') {
        return;
    }
    setExecuteActionImplementation(async (actionId: string, request: unknown) => {
        const call: Partial<ActionCallArgs> = isIndexableRecord(request) ? request : {};
        const { inputs, connectionId } = validateActionCall(
            call,
            allowedConnectionIds,
            `"${actionId}"`,
        );
        return executeAction(actionId, inputs, connectionId);
    });
}

/** No-ops if @datadog/apps-backend isn't installed; see `registerActionCatalogIfInstalled` for why this checks installedness up front rather than catching a load failure. */
async function registerBackendRuntimeIfInstalled(
    loadModule: LoadModule,
    projectRoot: string,
    $: unknown,
): Promise<void> {
    if (!isDatadogAppsBackendInstalled(projectRoot)) {
        return;
    }
    const [jsFunctionWithActionsModule, runtimeModule] = await Promise.all([
        loadModule('@datadog/apps-backend/runtime/jsFunctionWithActions'),
        loadModule('@datadog/apps-backend/runtime'),
    ]);
    const buildRuntimeFromJsFunctionWithActions =
        jsFunctionWithActionsModule.buildRuntimeFromJsFunctionWithActions;
    const setBackend = runtimeModule.setBackend;
    if (
        typeof buildRuntimeFromJsFunctionWithActions !== 'function' ||
        typeof setBackend !== 'function'
    ) {
        return;
    }
    setBackend(buildRuntimeFromJsFunctionWithActions($));
}

/** `globalThis.$` and the registrations above provide the same customer-visible bindings production's generated wrapper module sets up via text injection. */
export async function executeScriptLocally(
    func: BackendFunction,
    projectRoot: string,
    args: unknown[],
    executeAction: ExecuteAction,
    loadModule: LoadModule,
    log: Logger,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BackendOutputs> {
    // Never log the args themselves — they may carry secrets/PII, matching dev-server.ts's cloud path.
    log.debug(`Executing "${func.name}" in-process with args`);

    const $ = {
        backendFunctionArgs: args,
        Actions: makeActionsProxy(executeAction, func.allowedConnectionIds),
        Source: makeLocalDevSource(),
    };

    const run = async (): Promise<BackendOutputs> => {
        // Loads and evaluates the customer's module BEFORE installing $ and the SDK bridges below, matching production's own ordering (backend/virtual-entry.ts statically imports the customer module before its wrapper installs $ and the SDK bridges) — code that reaches for $ or a typed action during its own top-level evaluation fails the same way locally as it would in Datadog, instead of silently succeeding against bindings production wouldn't have installed yet.
        const mod = await loadModule(func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX);
        const fn = mod[func.name];
        if (typeof fn !== 'function') {
            throw new Error(`"${func.name}" is not a function exported from ${func.absolutePath}`);
        }

        // Restores whatever globalThis.$ held before this call (or removes it entirely if nothing did) once the execution settles, so a pre-existing global (e.g. from zx/globals) isn't permanently clobbered and a completed execution's own context isn't left reachable by unrelated process code.
        const hadPreviousDollar = Object.prototype.hasOwnProperty.call(globalThis, '$');
        const previousDollar = getGlobalDollar();
        setGlobalDollar($);
        try {
            await Promise.all([
                registerActionCatalogIfInstalled(
                    loadModule,
                    projectRoot,
                    executeAction,
                    func.allowedConnectionIds,
                ),
                registerBackendRuntimeIfInstalled(loadModule, projectRoot, $),
            ]);

            const result = await fn(...args);
            return { data: result };
        } finally {
            if (hadPreviousDollar) {
                setGlobalDollar(previousDollar);
            } else {
                deleteGlobalDollar();
            }
        }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`Local execution of "${func.name}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });

    // Racing against the timeout only stops the caller from waiting — run() keeps executing in-process afterward, so a customer function that resumes post-timeout can still fire real $.Actions side effects. True cancellation requires terminating a Worker thread, not possible for in-process execution.
    const runPromise = run();
    // Nothing awaits runPromise once the timeout has already settled the race — an unhandled rejection from it later would otherwise crash the whole dev server process. Logged (not swallowed silently) so a slow real failure is still diagnosable after the caller has already moved on.
    runPromise.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.debug(`"${func.name}" failed after its caller had already stopped waiting: ${message}`);
    });

    try {
        return await Promise.race([runPromise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
