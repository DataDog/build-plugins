// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis, NodeJS */

import { mockLogFn, mockLogger, moduleResolverFor } from '@dd/tests/_jest/helpers/mocks';

import * as shared from '../backend/shared';
import type { BackendFunction } from '../backend/types';
import { LOCAL_EXECUTION_LOAD_SUFFIX } from '../constants';

import type { ExecuteAction, LoadModule } from './local-execution';
import { executeScriptLocally } from './local-execution';

const func: BackendFunction = {
    relativePath: 'src/example',
    name: 'example',
    absolutePath: '/src/example.backend.ts',
    allowedConnectionIds: [],
};

const funcWithConnection: BackendFunction = { ...func, allowedConnectionIds: ['conn-1'] };

const TEST_PROJECT_ROOT = '/project';

interface TestGlobalDollar {
    backendFunctionArgs: unknown[];
    // Left untyped: $.Actions is a Proxy of unbounded, dynamic depth ($.Actions.<any>.<any>...(...)), the same shape a real customer's untyped code sees.
    Actions: any;
    Source: { initiator: { id: string; orgId: string }; runAsUser: { id: string; orgId: string } };
}

/** Reads the `$` this module installs onto `globalThis` during an execution, from the customer-code perspective these tests simulate — genuinely untyped from TypeScript's static perspective since it's a runtime-only accessor property local-execution.ts defines via `Object.defineProperty`. Centralized here instead of repeating the same cast at each call site. */
function testDollar(): TestGlobalDollar {
    return (globalThis as unknown as { $: TestGlobalDollar }).$;
}

/** Narrows a caught `unknown` to `Error` without an `as` cast — pairs with a preceding `expect(value).toBeInstanceOf(Error)` so the failure is reported there rather than as a thrown TypeError, and avoids `eslint-plugin-jest`'s no-conditional-expect rule that a plain `if (value instanceof Error)` guard around a second `expect(...)` would trip. */
function assertIsError(value: unknown): asserts value is Error {
    if (!(value instanceof Error)) {
        throw new Error(`Expected an Error, got: ${String(value)}`);
    }
}

beforeEach(() => {
    // Neither optional SDK is installed by default; tests exercising the "installed" path override this.
    jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(false);
    jest.spyOn(shared, 'isDatadogAppsBackendInstalled').mockReturnValue(false);
});

/**
 * Shape of the `$.Actions` dynamic proxy — an arbitrarily-nested property
 * path (e.g. `$.Actions.slack.chat.postMessage`) that's callable at any
 * depth. Used to type `globalThis.$` in tests without an `any` cast.
 */
type ActionsProxy = { [key: string]: ActionsProxy } & ((...args: unknown[]) => Promise<unknown>);

const stubExecuteAction: ExecuteAction = async (fqn) => ({ data: null, stub: true, fqn });

/** A `loadModule` double that resolves the customer's function from a map and rejects anything else with a module-not-found error, matching the common case where neither optional package is installed. */
function loadModuleReturning(exports: Record<string, unknown>): LoadModule {
    return moduleResolverFor(func, exports);
}

const ORDER_MARKER = '__ddLocalExecutionTestOrder';

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

    test('Should throw when a customer module reaches for $ during its own top-level evaluation, matching production module-evaluation order', async () => {
        let dollarAccessError: unknown = 'not captured';
        const loadModule: LoadModule = async (specifier) => {
            if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                // Production's static customer-module import runs before its wrapper installs $, so a
                // customer module reaching for $ during its own top-level evaluation fails there too —
                // this must fail the same way locally instead of silently resolving to undefined.
                try {
                    dollarAccessError = (globalThis as Record<string, unknown>).$;
                } catch (error) {
                    dollarAccessError = error;
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
        expect(dollarAccessError).toBeInstanceOf(Error);
        assertIsError(dollarAccessError);
        expect(dollarAccessError.message).toBe('No active local execution to resolve $ under.');
    });

    test("Should return a pre-existing globalThis.$ during a customer module's top-level evaluation when something (e.g. zx/globals) seeded it before this module loaded", async () => {
        const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, '$');
        const preExisting = { fromZxGlobals: true };
        (globalThis as Record<string, unknown>).$ = preExisting;
        let isolatedExecuteScriptLocally!: typeof executeScriptLocally;
        try {
            jest.isolateModules(() => {
                // A fresh module instance re-runs its top-level Reflect.has check with preExisting
                // already in place, capturing hadPreexistingDollar=true — the outer instance every other
                // test in this file uses was imported before any test set globalThis.$, so it can't
                // exercise this path.
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
        await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            (async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    // Simulates a customer module's own top-level side effect (e.g. `import 'zx/globals'`) writing $ before this execution's box exists.
                    (globalThis as Record<string, unknown>).$ = {
                        fromFirstExecutionTopLevel: true,
                    };
                    return { example: () => 'first' };
                }
                throw new Error(`Cannot find module '${specifier}'`);
            }) as LoadModule,
            mockLogger,
        );

        let dollarDuringSecondLoad: unknown = 'not captured';
        let secondLoadError: unknown;
        await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            (async (specifier: string) => {
                if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                    try {
                        dollarDuringSecondLoad = (globalThis as Record<string, unknown>).$;
                    } catch (error) {
                        secondLoadError = error;
                    }
                    return { example: () => 'second' };
                }
                throw new Error(`Cannot find module '${specifier}'`);
            }) as LoadModule,
            mockLogger,
        );

        expect(dollarDuringSecondLoad).toBe('not captured');
        expect(secondLoadError).toBeInstanceOf(Error);
        assertIsError(secondLoadError);
        expect(secondLoadError.message).toBe('No active local execution to resolve $ under.');
    });

    test('Should reject when loadModule itself rejects, same as a native-module load failure would', async () => {
        // Simulates a native addon failing to load at require()/import time, before the function is ever reached — not a customer function throwing.
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
        // $.Actions.slack.chat is itself a callable Proxy; forgetting the trailing .postMessage(...) call and just returning it must not make `await fn(...args)` treat it as a thenable and hang until the timeout, nor make assertJsonSerializable's JSON.stringify probe for .toJSON() leak an unhandled rejection — it should surface the same clear, synchronous "can't be serialized" error as any other bare function result.
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

    // Regression test: the "late failure" log is meant for an execution abandoned after the caller's own
    // await already gave up (see the test below), not every rejection — this one's caller is still waiting
    // and receives the same error normally via its own `rejects.toThrow` above.
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

    // executeAction stands in for dev-server.ts's real makeExecuteActionRemotely, whose long-poll can legitimately outlast a short hang-detection timeout — that's network wait time, not a hung customer function.
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
                    (
                        globalThis as typeof globalThis & { $: { Actions: ActionsProxy } }
                    ).$.Actions.slack.chat.postMessage({
                        inputs: { text: 'hi' },
                    }),
            }),
            mockLogger,
            50, // shorter than slowExecuteAction's own 80ms
        );

        expect(result).toEqual({ data: { ok: true } });
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
                        await (
                            globalThis as typeof globalThis & { $: { Actions: ActionsProxy } }
                        ).$.Actions.slack.chat.postMessage({
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

    // Asserts $'s exact key set, since a token added inside globalThis.$ wouldn't be caught by the weaker top-level check below.

    test('Should never expose an auth token to the customer module — only backendFunctionArgs, Actions, and Source are visible on globalThis.$', async () => {
        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({
                example: () => Object.keys(testDollar()).sort(),
            }),
            mockLogger,
        );
        expect(result).toEqual({ data: ['Actions', 'Source', 'backendFunctionArgs'] });
    });

    test('Should never expose an auth token via globalThis, including nested inside $.Source', async () => {
        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({
                example: () => {
                    // Recurses into $.Source (a plain data object) but not $.Actions (a Proxy dispatch mechanism, not a data container we'd leak a token into).
                    const containsTokenKey = (value: unknown): boolean =>
                        typeof value === 'object' &&
                        value !== null &&
                        Object.entries(value).some(
                            ([key, nested]) =>
                                key.toLowerCase().includes('token') || containsTokenKey(nested),
                        );
                    const dollar = testDollar();
                    return (
                        Object.keys(globalThis).some((k) => k.toLowerCase().includes('token')) ||
                        containsTokenKey(dollar.Source)
                    );
                },
            }),
            mockLogger,
        );
        expect(result).toEqual({ data: false });
    });

    test('Should populate $.Source with a synthetic local-dev identity, reachable via globalThis.$', async () => {
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
                initiator: { id: 'local-dev', orgId: 'local-dev-org' },
                runAsUser: { id: 'local-dev', orgId: 'local-dev-org' },
            },
        });
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
                initiator: { id: 'local-dev', orgId: 'local-dev-org' },
                runAsUser: { id: 'local-dev', orgId: 'local-dev-org' },
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
                // A fresh module instance re-runs its top-level Object.defineProperty, which must read
                // the current globalThis.$ (still `preExisting`, via the outer instance's own getter)
                // before replacing the descriptor with its own — not start from an empty slot.
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

            // Simulates `npm install @datadog/action-catalog` without restarting the dev server — the very next execution must register it, not stay permanently skipped from the first (uncached) negative check.
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

        // A sibling registration genuinely failing doesn't affect the action-catalog adapter — it's stable and execution-agnostic, so a call made once no execution is active correctly rejects on its own, with no special-case coordination needed between the two registrations.
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

        test('Should reject an explicit undefined nested inside a plain object, not just at the top level', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => ({ status: 'ok', extra: undefined }) }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*JSON.stringify silently drops/);
        });

        test('Should reject an explicit undefined at a property literally named the empty string, not mistake it for the JSON root', async () => {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => ({ '': undefined, other: 'ok' }) }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*JSON.stringify silently drops/);
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
            ).rejects.toThrow(/example.*JSON.stringify silently drops/);
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
            const order = (globalThis as Record<string, unknown>)[ORDER_MARKER];
            // Whichever call runs first, its start/end pair must be adjacent — a real race would interleave as [start-A, start-B, end-B, end-A].
            expect(order).toEqual([
                expect.stringMatching(/^start-/),
                expect.stringMatching(/^end-/),
                expect.stringMatching(/^start-/),
                expect.stringMatching(/^end-/),
            ]);
            expect((order as string[])[0].slice('start-'.length)).toEqual(
                (order as string[])[1].slice('end-'.length),
            );
            expect((order as string[])[2].slice('start-'.length)).toEqual(
                (order as string[])[3].slice('end-'.length),
            );
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

        // Covers the raw-$.Actions path: a captured Actions reference (e.g. const { Actions } = $) must reject once its own execution is abandoned, even after globalThis.$ is overwritten by a newer execution.
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
                        // Fires ~60ms in, squarely inside funcB's in-flight window — a fresh $ read here needs AsyncLocalStorage, not the abandoned closure check, or it would resolve to funcB's $.
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

            // Starts as soon as the queue frees and stays "current" for 80ms, overlapping the zombie's 60ms wakeup; never itself calls $.Actions, so any observed call must be the zombie's.
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

            // The zombie's fresh read resolved to its OWN $ (funcA's allowedConnectionIds) — funcB's connectionId under funcA's identity is rejected before reaching executeAction.
            expect(zombieOutcome).toEqual({
                rejected: expect.stringContaining("not in this function's allowed connections"),
            });
            expect(executeAction).not.toHaveBeenCalled();
        });

        // Action-catalog's registered dispatcher is stable and execution-agnostic — it resolves the calling execution's own dispatch from AsyncLocalStorage at call time, so a per-closure guard alone (bypassed once a newer execution re-registers) isn't what protects a stale typed-wrapper call.
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

            // registeredImpl still points at this (only) execution's own registration — no second execution registers here. The call is rejected because the dispatcher resolves this execution's own dispatch, already concluded by the 20ms timeout.
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(abandonedCallOutcome).toEqual({
                rejected: expect.stringContaining('already concluded'),
            });
        });

        // registeredImpl comes to point at funcB's own registration once it registers, but a call made from within funcA's own continuation still resolves funcA's own (concluded) dispatch via AsyncLocalStorage — it must still be rejected, not routed through funcB's identity/allowedConnectionIds just because funcB's registration is the one currently referenced.
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

            // Times out at 20ms, then calls the typed wrapper ~60ms in — squarely inside funcB's own in-flight window (funcB registers immediately but doesn't conclude until 80ms) — using conn-B, a connection funcA itself is never allowed to use.
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

        // The apps-backend loadModule call hangs forever here — a post-Promise.all destructuring assignment would never run, so publishing each handle via .then() as its own promise resolves is what lets the completed action-catalog registration still take effect.
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

        // A real dev server reuses the same loadModule for its whole lifetime — a registration load that never settles must not permanently poison every later execution sharing it, so this deliberately reuses one loadModule across two calls instead of each test's usual per-call closure.
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

        // A's slow-to-resolve registration re-installs the same stable, execution-agnostic dispatcher B's own registration already put in place — replacing the closure instance is harmless, since either one resolves a call against whichever execution is actually on the AsyncLocalStorage-scoped call stack, not against whichever registered it.
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
    });
});
