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

const ORDER_MARKER = '__ddLocalExecutionTestOrder';

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

    test('Should reject when loadModule itself rejects, same as a native-module load failure would', async () => {
        // Simulates e.g. a native addon failing to load at require()/import
        // time, rather than a customer function throwing during its own
        // logic — the failure happens before the function is ever reached.
        const loadModule: LoadModule = async () => {
            throw new Error('cannot find native module');
        };
        await expect(
            executeScriptLocally(func, [], stubExecuteAction, loadModule, mockLogger),
        ).rejects.toThrow('cannot find native module');
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

    test('Should never expose an auth token to the customer module — only backendFunctionArgs, Actions, and Source are visible on globalThis.$', async () => {
        const result = await executeScriptLocally(
            func,
            [],
            stubExecuteAction,
            loadModuleReturning({
                example: () => Object.keys((globalThis as Record<string, any>).$).sort(),
            }),
            mockLogger,
        );
        expect(result).toEqual({ data: ['Actions', 'Source', 'backendFunctionArgs'] });
    });

    test('Should never expose an auth token via globalThis either', async () => {
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

    describe('non-serializable results', () => {
        test('Should reject with a clear, attributed error when the result has a circular reference', async () => {
            await expect(
                executeScriptLocally(
                    func,
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
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: () => function notSerializable() {} }),
                    mockLogger,
                ),
            ).rejects.toThrow(/example.*JSON.stringify silently drops/);
        });

        test('Should allow an explicit undefined result through unchanged', async () => {
            const result = await executeScriptLocally(
                func,
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => undefined }),
                mockLogger,
            );
            expect(result).toEqual({ data: undefined });
        });
    });

    describe('network/subprocess guard', () => {
        test('Should reject when the customer function tries a raw net.Socket connection', async () => {
            await expect(
                executeScriptLocally(
                    func,
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
                [],
                executeAction,
                loadModuleReturning({
                    example: async () => {
                        const actionResult = await (
                            globalThis as Record<string, any>
                        ).$.Actions.slack.chat.postMessage({ inputs: { text: 'hi' } });
                        // A raw fetch attempted right after the sanctioned
                        // $.Actions call must still be blocked — the
                        // exemption is scoped to the one call, not the rest
                        // of the function.
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

        test('Should restore real network access after execution, for whatever the dev server itself does next', async () => {
            const realFetch = globalThis.fetch;
            await executeScriptLocally(
                func,
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => 'fine' }),
                mockLogger,
            );
            expect(globalThis.fetch).toBe(realFetch);
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
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: recordingOrder('A', 20) }),
                    mockLogger,
                ),
                executeScriptLocally(
                    func,
                    [],
                    stubExecuteAction,
                    loadModuleReturning({ example: recordingOrder('B', 0) }),
                    mockLogger,
                ),
            ]);

            expect([resultA, resultB]).toEqual([{ data: 'A' }, { data: 'B' }]);
            const order = (globalThis as Record<string, unknown>)[ORDER_MARKER];
            // Whichever call the queue happened to run first, its start/end
            // pair must be adjacent — never interrupted by the other call's
            // start. A real race (no queueing) would produce
            // ['start-A', 'start-B', 'end-B', 'end-A'] here, since B's 0ms
            // delay would let it finish first if both started immediately.
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

        test('Should still run the next queued execution after an earlier one rejects', async () => {
            const first = executeScriptLocally(
                func,
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
                [],
                stubExecuteAction,
                loadModuleReturning({ example: () => 2 }),
                mockLogger,
            );

            await expect(first).rejects.toThrow('first fails');
            await expect(second).resolves.toEqual({ data: 2 });
        });
    });
});
