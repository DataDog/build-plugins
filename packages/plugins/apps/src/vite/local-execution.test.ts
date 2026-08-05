// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import { mockLogger } from '@dd/tests/_jest/helpers/mocks';

import type { BackendFunction } from '../backend/types';

import type { ExecuteAction, LoadModule } from './local-execution';
import { executeScriptLocally } from './local-execution';

const func: BackendFunction = {
    relativePath: 'src/example',
    name: 'example',
    absolutePath: '/src/example.backend.ts',
    allowedConnectionIds: [],
};

const stubExecuteAction: ExecuteAction = async (fqn) => ({ data: null, stub: true, fqn });

/**
 * A `loadModule` double that resolves the customer's own function from a map
 * and rejects anything else (e.g. the action-catalog/apps-backend probes),
 * matching the common case where neither package is installed.
 */
function loadModuleReturning(exports: Record<string, unknown>): LoadModule {
    return async (specifier: string) => {
        if (specifier === func.absolutePath) {
            return exports;
        }
        throw new Error(`Cannot find module '${specifier}'`);
    };
}

describe('local-execution — executeScriptLocally', () => {
    test('Should run a simple function in-process and return its result', async () => {
        const result = await executeScriptLocally(
            func,
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
            [],
            stubExecuteAction,
            loadModuleReturning({ example: () => 1 }),
            mockLogger,
        );
        const second = await executeScriptLocally(
            func,
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
                [],
                stubExecuteAction,
                loadModuleReturning({ somethingElse: () => 1 }),
                mockLogger,
            ),
        ).rejects.toThrow(`"example" is not a function exported from ${func.absolutePath}`);
    });

    test('Should resolve a $.Actions.foo.bar(...) call through the injected executeAction, including connectionId', async () => {
        const executeAction = jest.fn().mockResolvedValue({ ok: true });
        const result = await executeScriptLocally(
            func,
            [],
            executeAction,
            loadModuleReturning({
                example: () =>
                    (globalThis as Record<string, any>).$.Actions.slack.chat.postMessage({
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

    test('Should reject when the action call is missing an inputs field', async () => {
        await expect(
            executeScriptLocally(
                func,
                [],
                stubExecuteAction,
                loadModuleReturning({
                    example: () =>
                        (globalThis as Record<string, any>).$.Actions.slack.chat.postMessage({}),
                }),
                mockLogger,
            ),
        ).rejects.toThrow(/must have an inputs field/);
    });

    test('Should reject with the thrown message when the customer function throws synchronously', async () => {
        await expect(
            executeScriptLocally(
                func,
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

    test('Should reject with the rejection reason when the customer function rejects asynchronously', async () => {
        await expect(
            executeScriptLocally(
                func,
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
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => new Promise(() => {}) }),
                mockLogger,
                50,
            ),
        ).rejects.toThrow(/timed out after 50ms/);
    });

    test('Should never expose an auth token via globalThis', async () => {
        const result = await executeScriptLocally(
            func,
            [],
            stubExecuteAction,
            loadModuleReturning({
                example: () =>
                    Object.keys(globalThis).some((k) => k.toLowerCase().includes('token')),
            }),
            mockLogger,
        );
        expect(result).toEqual({ data: false });
    });

    test('Should populate $.Source with a synthetic local-dev identity, reachable via globalThis.$', async () => {
        const result = await executeScriptLocally(
            func,
            [],
            stubExecuteAction,
            loadModuleReturning({ example: () => (globalThis as Record<string, any>).$.Source }),
            mockLogger,
        );
        expect(result).toEqual({
            data: {
                initiator: { id: 'local-dev', orgId: 'local-dev-org' },
                runAsUser: { id: 'local-dev', orgId: 'local-dev-org' },
            },
        });
    });

    describe('action-catalog / apps-backend registration', () => {
        test('Should silently skip registration when neither package is installed', async () => {
            // loadModuleReturning already rejects every specifier other than
            // func.absolutePath — this just confirms that doesn't surface as
            // an execution failure.
            const result = await executeScriptLocally(
                func,
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => 'fine' }),
                mockLogger,
            );
            expect(result).toEqual({ data: 'fine' });
        });

        test('Should route an action-catalog typed-wrapper call through the same injected executeAction', async () => {
            const executeAction = jest.fn().mockResolvedValue({ ok: true });
            let registeredImpl:
                | ((actionId: string, request: unknown) => Promise<unknown>)
                | undefined;

            const loadModule: LoadModule = async (specifier: string) => {
                if (specifier === func.absolutePath) {
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
                throw new Error(`Cannot find module '${specifier}'`);
            };

            const result = await executeScriptLocally(
                func,
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
    });

    describe('serialization of concurrent executions', () => {
        function delayedResult<T>(label: T, delayMs: number): () => Promise<T> {
            return () => new Promise((resolve) => setTimeout(() => resolve(label), delayMs));
        }

        test("Should allow two independent calls to run without cross-contaminating each other's result", async () => {
            const [resultA, resultB] = await Promise.all([
                executeScriptLocally(
                    func,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: delayedResult('A', 20) }),
                    mockLogger,
                ),
                executeScriptLocally(
                    func,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: delayedResult('B', 0) }),
                    mockLogger,
                ),
            ]);
            expect([resultA, resultB]).toEqual([{ data: 'A' }, { data: 'B' }]);
        });
    });
});
