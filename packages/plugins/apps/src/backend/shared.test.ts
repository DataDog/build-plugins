// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { SET_EXECUTE_ACTION_SNIPPET } from '@dd/apps-plugin/backend/shared';

/**
 * Evaluate SET_EXECUTE_ACTION_SNIPPET in a controlled scope and return the
 * callback that was registered via setExecuteActionImplementation.
 */
function extractRegisteredCallback(
    actions: Record<string, unknown>,
): (actionId: string, request: unknown) => Promise<unknown> {
    const setExecuteActionImplementation = jest.fn();
    const $ = { Actions: actions };

    // The snippet references `setExecuteActionImplementation` and `$` as free variables.
    // eslint-disable-next-line no-new-func
    const run = new Function('setExecuteActionImplementation', '$', SET_EXECUTE_ACTION_SNIPPET);
    run(setExecuteActionImplementation, $);

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
});
