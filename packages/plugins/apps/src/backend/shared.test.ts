// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { CONNECTION_LABELS_UPGRADE_MESSAGE } from '@dd/apps-plugin/backend/connection-labels';
import {
    CONNECTION_LABELS_IMPORT,
    SET_BACKEND_CONTEXT_SNIPPET,
    SET_EXECUTE_ACTION_SNIPPET,
} from '@dd/apps-plugin/backend/shared';

describe('CONNECTION_LABELS_IMPORT', () => {
    test('imports the swap from the action-catalog subpath', () => {
        expect(CONNECTION_LABELS_IMPORT).toBe(
            "import { readResolvedConnections, swapConnectionLabel } from '@datadog/action-catalog/connection-labels';",
        );
    });
});

describe('SET_BACKEND_CONTEXT_SNIPPET', () => {
    test('registers the backend runtime context', () => {
        const runtimeHandle = { opaque: true };
        const buildRuntimeFromJsFunctionWithActions = jest.fn().mockReturnValue(runtimeHandle);
        const setBackend = jest.fn();
        const context = { Source: { initiator: { id: 'user-id' } } };

        // eslint-disable-next-line no-new-func
        const run = new Function(
            'buildRuntimeFromJsFunctionWithActions',
            'setBackend',
            '$',
            SET_BACKEND_CONTEXT_SNIPPET,
        );
        run(buildRuntimeFromJsFunctionWithActions, setBackend, context);

        expect(buildRuntimeFromJsFunctionWithActions).toHaveBeenCalledWith(context);
        expect(setBackend).toHaveBeenCalledWith(runtimeHandle);
    });

    test('does not throw when buildRuntimeFromJsFunctionWithActions/setBackend are unavailable', () => {
        // eslint-disable-next-line no-new-func
        const run = new Function(
            'buildRuntimeFromJsFunctionWithActions',
            'setBackend',
            '$',
            SET_BACKEND_CONTEXT_SNIPPET,
        );

        expect(() => run(undefined, undefined, {})).not.toThrow();
    });
});

/**
 * Evaluate SET_EXECUTE_ACTION_SNIPPET in a controlled scope and return the
 * callback that was registered via setExecuteActionImplementation.
 */
function extractRegisteredCallback(
    actions: Record<string, unknown>,
    runtimeContext: Record<string, unknown> = {},
    connectionLabelsHelper?: {
        readResolvedConnections: (runtimeContext: unknown) => unknown;
        swapConnectionLabel: (request: unknown, resolved: unknown) => unknown;
    },
): (actionId: string, request: unknown) => Promise<unknown> {
    const setExecuteActionImplementation = jest.fn();
    const $ = { ...runtimeContext, Actions: actions };

    // The snippet references these as free variables. Without the helper they stay undeclared,
    // as in an entry generated without its import.
    if (connectionLabelsHelper) {
        // eslint-disable-next-line no-new-func
        const run = new Function(
            'setExecuteActionImplementation',
            'readResolvedConnections',
            'swapConnectionLabel',
            '$',
            SET_EXECUTE_ACTION_SNIPPET,
        );
        run(
            setExecuteActionImplementation,
            connectionLabelsHelper.readResolvedConnections,
            connectionLabelsHelper.swapConnectionLabel,
            $,
        );
    } else {
        // eslint-disable-next-line no-new-func
        const run = new Function('setExecuteActionImplementation', '$', SET_EXECUTE_ACTION_SNIPPET);
        run(setExecuteActionImplementation, $);
    }

    expect(setExecuteActionImplementation).toHaveBeenCalledTimes(1);
    return setExecuteActionImplementation.mock.calls[0][0];
}

describe('SET_EXECUTE_ACTION_SNIPPET', () => {
    describe('guard check', () => {
        test('does not call setExecuteActionImplementation when it is not a function', () => {
            // eslint-disable-next-line no-new-func
            const run = new Function(
                'setExecuteActionImplementation',
                '$',
                SET_EXECUTE_ACTION_SNIPPET,
            );
            // Passing undefined — the typeof guard should prevent calling it.
            expect(() => run(undefined, { Actions: {} })).not.toThrow();
        });
    });

    describe('registered callback', () => {
        const actionFn = jest.fn().mockResolvedValue('result');

        beforeEach(() => {
            actionFn.mockClear();
        });

        const successCases = [
            {
                description: 'strip com.datadoghq. prefix and resolve a single-level action',
                actionId: 'com.datadoghq.myAction',
                actions: { myAction: actionFn },
                request: { key: 'val' },
            },
            {
                description: 'resolve a nested action path',
                actionId: 'com.datadoghq.ns.sub.myAction',
                actions: { ns: { sub: { myAction: actionFn } } },
                request: {},
            },
            {
                description: 'not strip a non-matching prefix',
                actionId: 'custom.myAction',
                actions: { custom: { myAction: actionFn } },
                request: {},
            },
        ];

        test.each(successCases)('should $description', async ({ actionId, actions, request }) => {
            const callback = extractRegisteredCallback(actions);
            await callback(actionId, request);
            expect(actionFn).toHaveBeenCalledWith(request);
        });

        test('should return the action function return value', async () => {
            const echo = jest.fn((r) => r);
            const callback = extractRegisteredCallback({ echo });
            const result = await callback('com.datadoghq.echo', { data: 42 });
            expect(result).toEqual({ data: 42 });
        });

        const errorCases = [
            {
                description: 'throw "Action not found" for a missing intermediate path',
                actionId: 'com.datadoghq.missing.action',
                actions: {},
                expectedError: 'Action not found: com.datadoghq.missing.action',
            },
            {
                description:
                    'throw "Action is not a function" when the resolved value is not callable',
                actionId: 'com.datadoghq.notAFn',
                actions: { notAFn: 'hello' },
                expectedError: 'Action is not a function: com.datadoghq.notAFn',
            },
        ];

        test.each(errorCases)(
            'should $description',
            async ({ actionId, actions, expectedError }) => {
                const callback = extractRegisteredCallback(actions);
                await expect(callback(actionId, {})).rejects.toThrow(expectedError);
            },
        );
    });

    describe('connection labels', () => {
        const actionFn = jest.fn().mockResolvedValue('result');

        beforeEach(() => {
            actionFn.mockClear();
        });

        describe('with the action-catalog helper', () => {
            const resolved = { hasConnectionEnvs: true, connections: { jira: 'resolved-id' } };
            const makeHelper = () => ({
                readResolvedConnections: jest.fn().mockReturnValue(resolved),
                swapConnectionLabel: jest.fn().mockReturnValue({ connectionId: 'resolved-id' }),
            });

            test('should read $ once, before any call', async () => {
                const helper = makeHelper();
                const runtimeContext = { Connections: { jira: 'resolved-id' } };
                const callback = extractRegisteredCallback(
                    { http: actionFn },
                    runtimeContext,
                    helper,
                );
                expect(helper.readResolvedConnections).toHaveBeenCalledTimes(1);
                expect(helper.readResolvedConnections).toHaveBeenCalledWith(
                    expect.objectContaining(runtimeContext),
                );
                await callback('com.datadoghq.http', { connectionLabel: 'jira' });
                await callback('com.datadoghq.http', { connectionLabel: 'jira' });
                expect(helper.readResolvedConnections).toHaveBeenCalledTimes(1);
            });

            const passedCases = [
                {
                    description: 'pass a label call to the helper and run the request it returns',
                    request: { connectionLabel: 'jira', inputs: {} },
                },
                {
                    description: 'pass a non-label call to the helper too',
                    request: { connectionId: 'conn-1', inputs: {} },
                },
            ];

            test.each(passedCases)('should $description', async ({ request }) => {
                const helper = makeHelper();
                const callback = extractRegisteredCallback({ http: actionFn }, {}, helper);
                await callback('com.datadoghq.http', request);
                expect(helper.swapConnectionLabel).toHaveBeenCalledWith(request, resolved);
                expect(actionFn).toHaveBeenCalledWith({ connectionId: 'resolved-id' });
            });

            test('should not run the action when the helper fails closed', async () => {
                const helper = makeHelper();
                helper.swapConnectionLabel.mockImplementation(() => {
                    throw new Error('Connection label "jira" is not mapped');
                });
                const callback = extractRegisteredCallback({ http: actionFn }, {}, helper);
                await expect(
                    callback('com.datadoghq.http', { connectionLabel: 'jira' }),
                ).rejects.toThrow('Connection label "jira" is not mapped');
                expect(actionFn).not.toHaveBeenCalled();
            });
        });

        describe('without the action-catalog helper', () => {
            test('should run a non-label call unchanged', async () => {
                const request = { connectionId: 'conn-1', inputs: {} };
                const callback = extractRegisteredCallback({ http: actionFn });
                await callback('com.datadoghq.http', request);
                expect(actionFn).toHaveBeenCalledWith(request);
                expect(actionFn.mock.calls[0][0]).toBe(request);
            });

            test.each([
                {
                    description: 'a label call',
                    request: { connectionLabel: 'jira', connectionId: 'fallback-id', inputs: {} },
                },
                {
                    description: 'a label-only call',
                    request: { connectionLabel: 'jira', inputs: {} },
                },
            ])('should fail $description, asking to upgrade', async ({ request }) => {
                const callback = extractRegisteredCallback({ http: actionFn });
                await expect(callback('com.datadoghq.http', request)).rejects.toThrow(
                    CONNECTION_LABELS_UPGRADE_MESSAGE,
                );
                expect(actionFn).not.toHaveBeenCalled();
            });
        });
    });
});
