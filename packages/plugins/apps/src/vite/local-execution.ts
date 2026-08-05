// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global Proxy, globalThis */

/**
 * Local Node execution for backend functions. The customer's real
 * `*.backend.ts` file is imported directly via `loadModule` — no bundling,
 * no wrapper module — and its exported function is called with its own real
 * arguments, inside this process (the Vite dev server's own process). The
 * dev server is already the isolation boundary from production, so a crash
 * or hang here only affects the developer's own dev server.
 *
 * Parallel structure to executeScriptViaDatadog in dev-server.ts: same
 * BackendOutputs return shape, so it's a drop-in alternate implementation
 * behind the same contract, not a protocol change.
 */

import type { Logger } from '@dd/core/types';

import type { BackendFunction } from '../backend/types';

type BackendOutputs = { data: unknown };

interface ActionCallArgs {
    inputs: Record<string, unknown>;
    connectionId?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Loads a module by specifier — either the customer's own backend-function
 * file (an absolute path) or a bare npm specifier (e.g.
 * `@datadog/action-catalog/action-execution`). Either way this must resolve
 * against the customer's own project, not build-plugins' own dependency
 * tree — build-plugins doesn't (and shouldn't) depend on either package
 * itself. The dev server passes its Vite instance's own `ssrLoadModule` here,
 * which resolves and transforms against the customer's project exactly like
 * a real bundle would, with an HMR-aware module cache so edited files are
 * re-transformed automatically — no content-addressing trick needed.
 */
export type LoadModule = (specifier: string) => Promise<Record<string, unknown>>;

/**
 * Makes a real `$.Actions.foo.bar(...)` call (and, transitively, any
 * @datadog/action-catalog typed-wrapper call — see
 * `registerActionCatalogIfInstalled`) happen. The dev server supplies the
 * real implementation (a single-action `preview-async` call, using its own
 * auth) — this module never holds or sees a credential itself, only this
 * function signature.
 */
export type ExecuteAction = (
    fqn: string,
    inputs: unknown,
    connectionId: string | undefined,
) => Promise<unknown>;

/**
 * Fake local-dev identity for `$.Source`. No real user session exists on a
 * developer's own machine, so this is a fixed, synthetic value — not derived
 * from any real auth. It's enough for `@datadog/apps-backend`'s
 * `getInitiatingUser()`/`getExecutionUser()` (and raw `$.Source.initiator`
 * access) to resolve instead of throwing, which is all local dev needs from
 * it today.
 */
const LOCAL_DEV_SOURCE = {
    initiator: { id: 'local-dev', orgId: 'local-dev-org' },
    runAsUser: { id: 'local-dev', orgId: 'local-dev-org' },
};

/**
 * Build the $.Actions Proxy. Resolves any nested property path (e.g.
 * $.Actions.slack.chat.postMessage) to a callable that invokes
 * `executeAction` directly, in-process — no IPC serialization needed, since
 * there's no separate process to cross.
 */
function makeActionsProxy(executeAction: ExecuteAction, pathParts: string[] = []): unknown {
    return new Proxy(function () {}, {
        get(_target, prop) {
            return makeActionsProxy(executeAction, pathParts.concat(String(prop)));
        },
        apply(_target, _thisArg, args: unknown[]) {
            if (args.length === 0) {
                return Promise.reject(
                    new Error(`No arguments provided to action $.Actions.${pathParts.join('.')}`),
                );
            }
            const { inputs, connectionId } = (args[0] ?? {}) as Partial<ActionCallArgs>;
            if (typeof inputs !== 'object' || !inputs) {
                return Promise.reject(
                    new Error(
                        `First argument to action $.Actions.${pathParts.join('.')} must have an inputs field`,
                    ),
                );
            }
            const fqn = `com.datadoghq.${pathParts.join('.')}`;
            return executeAction(fqn, inputs, connectionId);
        },
    });
}

/**
 * Mirrors production's SET_EXECUTE_ACTION_SNIPPET (previously injected as
 * text into a generated wrapper module): registers action-catalog's
 * module-level executeAction implementation, so a customer's typed-wrapper
 * import (e.g. `import { request } from '@datadog/action-catalog/http/http'`)
 * calls the same `executeAction` a raw `$.Actions.*` call would. A silent
 * no-op if @datadog/action-catalog isn't installed in the customer's app,
 * matching production's own isActionCatalogInstalled gate.
 */
async function registerActionCatalogIfInstalled(
    loadModule: LoadModule,
    executeAction: ExecuteAction,
): Promise<void> {
    let mod: Record<string, unknown>;
    try {
        mod = await loadModule('@datadog/action-catalog/action-execution');
    } catch {
        return;
    }
    const setExecuteActionImplementation = mod.setExecuteActionImplementation;
    if (typeof setExecuteActionImplementation !== 'function') {
        return;
    }
    setExecuteActionImplementation(async (actionId: string, request: unknown) => {
        const { inputs, connectionId } = (request ?? {}) as Partial<ActionCallArgs>;
        return executeAction(actionId, inputs, connectionId);
    });
}

/**
 * Mirrors production's SET_BACKEND_CONTEXT_SNIPPET (previously injected as
 * text into a generated wrapper module): registers @datadog/apps-backend's
 * runtime context so a customer's typed accessor calls (e.g.
 * getInitiatingUser()) resolve against `$.Source` instead of throwing. A
 * silent no-op if @datadog/apps-backend isn't installed, matching
 * production's own isDatadogAppsBackendInstalled gate.
 */
async function registerBackendRuntimeIfInstalled(
    loadModule: LoadModule,
    $: unknown,
): Promise<void> {
    let jsFunctionWithActionsModule: Record<string, unknown>;
    let runtimeModule: Record<string, unknown>;
    try {
        [jsFunctionWithActionsModule, runtimeModule] = await Promise.all([
            loadModule('@datadog/apps-backend/runtime/jsFunctionWithActions'),
            loadModule('@datadog/apps-backend/runtime'),
        ]);
    } catch {
        return;
    }
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

/**
 * Execute a backend function in-process by importing its real file directly
 * — no bundling, no generated wrapper module. `globalThis.$` and the
 * action-catalog/apps-backend registrations above stand in for what the
 * removed `main($)` wrapper used to do textually; everything else about the
 * call is just invoking the customer's exported function with its own real
 * arguments.
 */
export async function executeScriptLocally(
    func: BackendFunction,
    args: unknown[],
    executeAction: ExecuteAction,
    loadModule: LoadModule,
    log: Logger,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BackendOutputs> {
    log.debug(`Executing "${func.name}" in-process with args=${JSON.stringify(args)}`);

    const $ = {
        backendFunctionArgs: args,
        Actions: makeActionsProxy(executeAction),
        Source: LOCAL_DEV_SOURCE,
    };

    const run = async (): Promise<BackendOutputs> => {
        (globalThis as Record<string, unknown>).$ = $;
        await Promise.all([
            registerActionCatalogIfInstalled(loadModule, executeAction),
            registerBackendRuntimeIfInstalled(loadModule, $),
        ]);

        const mod = await loadModule(func.absolutePath);
        const fn = mod[func.name];
        if (typeof fn !== 'function') {
            throw new Error(`"${func.name}" is not a function exported from ${func.absolutePath}`);
        }

        const result = await fn(...args);
        return { data: result };
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`Local execution of "${func.name}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });

    try {
        return await Promise.race([run(), timeout]);
    } finally {
        clearTimeout(timer);
    }
}
