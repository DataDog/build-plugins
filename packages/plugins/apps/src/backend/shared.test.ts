// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    SET_BACKEND_CONTEXT_SNIPPET,
    SET_ENVIRONMENT_VARIABLES_SNIPPET,
    SET_EXECUTE_ACTION_SNIPPET,
} from '@dd/apps-plugin/backend/shared';

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
    environment?: unknown,
): (actionId: string, request: unknown) => Promise<unknown> {
    const setExecuteActionImplementation = jest.fn();
    const $ = { Actions: actions, Environment: environment };

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

describe('SET_EXECUTE_ACTION_SNIPPET connection bindings', () => {
    const CODE_ID = 'abcdef11-1111-4111-8111-111111111111';
    const BOUND_ID = '22222222-2222-4222-8222-222222222222';
    const OTHER_ID = '33333333-3333-4333-8333-333333333333';
    const bindings = { name: 'staging', connections: { [CODE_ID]: BOUND_ID }, variables: {} };

    const cases = [
        {
            description: 'swap a bound connectionId',
            environment: bindings,
            request: { connectionId: CODE_ID, inputs: { a: 1 } },
            expected: { connectionId: BOUND_ID, inputs: { a: 1 } },
        },
        {
            description: 'swap a bound connectionId written in uppercase',
            environment: bindings,
            request: { connectionId: CODE_ID.toUpperCase() },
            expected: { connectionId: BOUND_ID },
        },
        {
            description: 'keep an unbound connectionId in production',
            environment: { ...bindings, name: 'production' },
            request: { connectionId: OTHER_ID },
            expected: { connectionId: OTHER_ID },
        },
        {
            description: 'keep an unbound connectionId when the environment has no name',
            environment: { connections: { [CODE_ID]: BOUND_ID } },
            request: { connectionId: OTHER_ID },
            expected: { connectionId: OTHER_ID },
        },
        {
            description: 'keep the IDs in code without $.Environment',
            environment: undefined,
            request: { connectionId: CODE_ID },
            expected: { connectionId: CODE_ID },
        },
        {
            description: 'keep the IDs in code when connections is not an object',
            environment: { connections: 'nope' },
            request: { connectionId: CODE_ID },
            expected: { connectionId: CODE_ID },
        },
        {
            description: 'ignore inherited keys such as constructor',
            environment: { name: 'production', connections: {} },
            request: { connectionId: 'constructor' },
            expected: { connectionId: 'constructor' },
        },
        {
            description: 'ignore a non-string bound value',
            environment: { name: 'production', connections: { [CODE_ID]: 42 } },
            request: { connectionId: CODE_ID },
            expected: { connectionId: CODE_ID },
        },
        {
            description: 'pass a request without connectionId through',
            environment: bindings,
            request: { inputs: {} },
            expected: { inputs: {} },
        },
    ];

    test.each(cases)('should $description', async ({ environment, request, expected }) => {
        const actionFn = jest.fn().mockResolvedValue('ok');
        const callback = extractRegisteredCallback({ http: { request: actionFn } }, environment);
        const original = JSON.parse(JSON.stringify(request));

        await callback('com.datadoghq.http.request', request);

        expect(actionFn).toHaveBeenCalledWith(expected);
        expect(request).toEqual(original);
    });

    test.each([
        { description: 'an unbound connectionId', connectionId: OTHER_ID },
        { description: 'an inherited key such as constructor', connectionId: 'constructor' },
    ])('should refuse $description outside production', async ({ connectionId }) => {
        const actionFn = jest.fn().mockResolvedValue('ok');
        const callback = extractRegisteredCallback({ http: { request: actionFn } }, bindings);

        await expect(callback('com.datadoghq.http.request', { connectionId })).rejects.toThrow(
            `Connection ${connectionId} has no binding in environment "staging".`,
        );
        expect(actionFn).not.toHaveBeenCalled();
    });

    test('should pass a non-object request through unchanged', async () => {
        const actionFn = jest.fn().mockResolvedValue('ok');
        const callback = extractRegisteredCallback({ echo: actionFn }, bindings);
        await callback('com.datadoghq.echo', undefined);
        expect(actionFn).toHaveBeenCalledWith(undefined);
    });
});

describe('SET_ENVIRONMENT_VARIABLES_SNIPPET', () => {
    function runWith(environment: unknown, env: Record<string, string | undefined>) {
        const fakeProcess = { env };
        // eslint-disable-next-line no-new-func
        const run = new Function('$', 'process', SET_ENVIRONMENT_VARIABLES_SNIPPET);
        run({ Environment: environment }, fakeProcess);
        return fakeProcess.env;
    }

    const cases = [
        {
            description: 'copy string variables into process.env',
            environment: { variables: { SITE: 'datad0g.com' } },
            before: { PATH: '/bin' },
            expected: { PATH: '/bin', SITE: 'datad0g.com' },
        },
        {
            description: 'override an existing value',
            environment: { variables: { SITE: 'datad0g.com' } },
            before: { SITE: 'datadoghq.com' },
            expected: { SITE: 'datad0g.com' },
        },
        {
            description: 'skip non-string values',
            environment: { variables: { SITE: 7, OK: 'yes' } },
            before: {},
            expected: { OK: 'yes' },
        },
        {
            description: 'do nothing without $.Environment',
            environment: undefined,
            before: { PATH: '/bin' },
            expected: { PATH: '/bin' },
        },
        {
            description: 'do nothing when variables is not an object',
            environment: { variables: ['SITE'] },
            before: {},
            expected: {},
        },
    ];

    test.each(cases)('should $description', ({ environment, before, expected }) => {
        expect(runWith(environment, { ...before })).toEqual(expected);
    });

    test('should not throw when process is unavailable', () => {
        // eslint-disable-next-line no-new-func
        const run = new Function('$', 'process', SET_ENVIRONMENT_VARIABLES_SNIPPET);
        expect(() => run({ Environment: { variables: { A: 'b' } } }, undefined)).not.toThrow();
    });
});
