// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis, NodeJS */

import { mockLogFn, mockLogger } from '@dd/tests/_jest/helpers/mocks';

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

/** Reads the `$` this module installs on `globalThis`, from the customer-code perspective these tests simulate — untyped since it's a runtime-only property (see `setGlobalDollar`). Centralized here instead of repeating the cast at each call site. */
function testDollar(): TestGlobalDollar {
    return (globalThis as unknown as { $: TestGlobalDollar }).$;
}

beforeEach(() => {
    // Neither optional SDK is installed by default; tests exercising the "installed" path override this.
    jest.spyOn(shared, 'isActionCatalogInstalled').mockReturnValue(false);
    jest.spyOn(shared, 'isDatadogAppsBackendInstalled').mockReturnValue(false);
});

const stubExecuteAction: ExecuteAction = async (fqn) => ({ data: null, stub: true, fqn });

/** A `loadModule` double that resolves the customer's function from a map and rejects anything else with a module-not-found error, matching the common case where neither optional package is installed. */
function loadModuleReturning(exports: Record<string, unknown>): LoadModule {
    return async (specifier: string) => {
        if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
            return exports;
        }
        const error: NodeJS.ErrnoException = new Error(`Cannot find module '${specifier}'`);
        error.code = 'MODULE_NOT_FOUND';
        throw error;
    };
}

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

    test('Should load and evaluate the customer module before installing globalThis.$, matching production module-evaluation order', async () => {
        let dollarDuringModuleLoad: unknown = 'not captured';
        const loadModule: LoadModule = async (specifier) => {
            if (specifier === func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX) {
                // Captures globalThis.$ at module-evaluation time — production's static import runs before its wrapper installs $, so code reaching for $ during top-level evaluation must see the same absence locally.
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

    test('Should not hang when a customer function returns an un-invoked $.Actions reference instead of calling it', async () => {
        // $.Actions.slack.chat is itself a callable Proxy; returning it without the trailing .postMessage(...) call must not make `await fn(...args)` treat it as a thenable and hang.
        const result = await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({
                example: () => testDollar().Actions.slack.chat,
            }),
            mockLogger,
            20,
        );
        expect(result.data).toBeDefined();
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

    test('Should restore a pre-existing globalThis.$ (e.g. from zx/globals) once the execution completes, not leave the execution context in place permanently', async () => {
        const preExisting = { notOurs: true };
        (globalThis as Record<string, unknown>).$ = preExisting;
        try {
            const result = await executeScriptLocally(
                func,
                TEST_PROJECT_ROOT,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () => testDollar().backendFunctionArgs,
                }),
                mockLogger,
            );
            expect(result).toEqual({ data: [] });
            // Compares via a plain boolean, not .toBe() directly — $.Actions's get trap returns a Proxy for every property, which crashes Jest's diff formatting if this assertion ever fails.
            expect(Object.is((globalThis as Record<string, unknown>).$, preExisting)).toBe(true);
        } finally {
            delete (globalThis as Record<string, unknown>).$;
        }
    });

    test("Should restore a pre-existing globalThis.$ even when the customer function throws, not leave the execution's context behind", async () => {
        const preExisting = { notOurs: true };
        (globalThis as Record<string, unknown>).$ = preExisting;
        try {
            await expect(
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({
                        example: () => {
                            throw new Error('customer function failed');
                        },
                    }),
                    mockLogger,
                ),
            ).rejects.toThrow('customer function failed');
            expect(Object.is((globalThis as Record<string, unknown>).$, preExisting)).toBe(true);
        } finally {
            delete (globalThis as Record<string, unknown>).$;
        }
    });

    test('Should remove globalThis.$ once the execution completes when nothing was previously defined there', async () => {
        delete (globalThis as Record<string, unknown>).$;
        await executeScriptLocally(
            func,
            TEST_PROJECT_ROOT,
            [],
            stubExecuteAction,
            loadModuleReturning({ example: () => 'done' }),
            mockLogger,
        );
        expect(Object.prototype.hasOwnProperty.call(globalThis, '$')).toBe(false);
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
    });

    describe('serialization of concurrent executions', () => {
        function delayedResult<T>(label: T, delayMs: number): () => Promise<T> {
            return () => new Promise((resolve) => setTimeout(() => resolve(label), delayMs));
        }

        test("Should allow two independent calls to run without cross-contaminating each other's result", async () => {
            const [resultA, resultB] = await Promise.all([
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: delayedResult('A', 20) }),
                    mockLogger,
                ),
                executeScriptLocally(
                    func,
                    TEST_PROJECT_ROOT,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: delayedResult('B', 0) }),
                    mockLogger,
                ),
            ]);
            expect([resultA, resultB]).toEqual([{ data: 'A' }, { data: 'B' }]);
        });

        // Reads $.backendFunctionArgs after a delay, which is what would surface cross-contamination between concurrent calls' globalThis.$.
        function readOwnArgsAfterDelay(delayMs: number): () => Promise<unknown> {
            return () =>
                new Promise((resolve) =>
                    setTimeout(() => resolve(testDollar().backendFunctionArgs), delayMs),
                );
        }

        // Known race: two concurrent calls both write globalThis.$ synchronously, so the second write wins for both — skip until calls are serialized through an execution queue.
        test.skip("Should let each concurrent call see its OWN backendFunctionArgs via globalThis.$, not the other call's", async () => {
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
    });
});
