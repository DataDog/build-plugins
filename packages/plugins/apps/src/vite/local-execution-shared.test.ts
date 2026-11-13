// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    connectionLabelFailClosedCases,
    connectionLabelSwapCases,
} from '@dd/apps-plugin/backend/connection-labels.fixtures';
import type { ActionCallArgs } from '@dd/apps-plugin/vite/local-execution-shared';
import {
    CONNECTIONS_CONTEXT_KEY,
    getResolvedConnectionIds,
    HAS_CONNECTION_ENVS_CONTEXT_KEY,
    readResolvedConnections,
    swapConnectionLabel,
    validateActionCallShape,
} from '@dd/apps-plugin/vite/local-execution-shared';

const actionDescription = '$.Actions.http.request';
const missingInputs = `First argument to action ${actionDescription} must have an inputs field that is an object`;

describe('local-execution-shared — validateActionCallShape', () => {
    const rejected: Array<{ description: string; call: Partial<ActionCallArgs>; error: string }> = [
        {
            description: 'reject a call with no inputs',
            call: {},
            error: missingInputs,
        },
        {
            description: 'reject null inputs',
            call: { inputs: null as unknown as Record<string, unknown> },
            error: missingInputs,
        },
        {
            description: 'reject non-object inputs',
            call: { inputs: 'url' as unknown as Record<string, unknown> },
            error: missingInputs,
        },
        {
            description: 'reject inputs that declare their own allowedConnectionIds',
            call: { inputs: { url: 'https://example.com', allowedConnectionIds: ['conn-a'] } },
            error: `Action ${actionDescription} must not declare its own allowedConnectionIds in inputs`,
        },
        {
            description: 'reject inputs that declare an empty allowedConnectionIds',
            call: { inputs: { allowedConnectionIds: [] }, connectionId: 'conn-a' },
            error: `Action ${actionDescription} must not declare its own allowedConnectionIds in inputs`,
        },
    ];

    test.each(rejected)('Should $description', ({ call, error }) => {
        expect(() => validateActionCallShape(call, actionDescription)).toThrow(error);
    });

    const accepted: Array<{ description: string; call: Partial<ActionCallArgs> }> = [
        {
            description: 'return a call with a connectionId unchanged',
            call: { inputs: { url: 'https://example.com' }, connectionId: 'conn-a' },
        },
        {
            description: 'return a call without a connectionId unchanged',
            call: { inputs: { url: 'https://example.com' } },
        },
        {
            description: 'accept a connectionId outside any allowlist, leaving that to the caller',
            call: { inputs: {}, connectionId: 'not-in-any-allowlist' },
        },
        {
            description: 'accept allowedConnectionIds inherited from a prototype',
            call: { inputs: Object.create({ allowedConnectionIds: ['conn-a'] }) },
        },
    ];

    test.each(accepted)('Should $description', ({ call }) => {
        const validated = validateActionCallShape(call, actionDescription);

        expect(validated.inputs).toBe(call.inputs);
        expect(validated.connectionId).toBe(call.connectionId);
    });
});

describe('local-execution-shared — swapConnectionLabel', () => {
    test.each(connectionLabelSwapCases)(
        'Should $description',
        ({ runtimeContext, request, expected }) => {
            const resolved = readResolvedConnections(runtimeContext);

            expect(swapConnectionLabel(request, resolved)).toEqual(expected);
        },
    );

    test.each(connectionLabelFailClosedCases)(
        'Should fail closed on $description',
        ({ runtimeContext, request, expectedError }) => {
            const resolved = readResolvedConnections(runtimeContext);

            expect(() => swapConnectionLabel(request, resolved)).toThrow(expectedError);
        },
    );

    test('Should not mutate the request', () => {
        const request = { connectionLabel: 'jira', connectionId: 'fallback-id', inputs: {} };
        const runtimeContext = {
            [HAS_CONNECTION_ENVS_CONTEXT_KEY]: true,
            [CONNECTIONS_CONTEXT_KEY]: { jira: 'resolved' },
        };

        const resolved = readResolvedConnections(runtimeContext);
        swapConnectionLabel(request, resolved);

        expect(request).toEqual({
            connectionLabel: 'jira',
            connectionId: 'fallback-id',
            inputs: {},
        });
    });
});

describe('local-execution-shared — getResolvedConnectionIds', () => {
    const cases: {
        description: string;
        runtimeContext: Record<string, unknown>;
        expected: string[];
    }[] = [
        {
            description: 'return each resolved ID once',
            runtimeContext: {
                [HAS_CONNECTION_ENVS_CONTEXT_KEY]: true,
                [CONNECTIONS_CONTEXT_KEY]: { jira: 'id-a', slack: 'id-b', pd: 'id-a' },
            },
            expected: ['id-a', 'id-b'],
        },
        {
            description: 'return nothing when the app has no config',
            runtimeContext: {
                [HAS_CONNECTION_ENVS_CONTEXT_KEY]: false,
                [CONNECTIONS_CONTEXT_KEY]: { jira: 'id-a' },
            },
            expected: [],
        },
        {
            description: 'return nothing when the server sent neither key',
            runtimeContext: {},
            expected: [],
        },
        {
            description: 'skip non-string values',
            runtimeContext: {
                [HAS_CONNECTION_ENVS_CONTEXT_KEY]: true,
                [CONNECTIONS_CONTEXT_KEY]: { jira: 42, slack: 'id-b' },
            },
            expected: ['id-b'],
        },
        {
            description: 'return nothing when the map is not an object',
            runtimeContext: {
                [HAS_CONNECTION_ENVS_CONTEXT_KEY]: true,
                [CONNECTIONS_CONTEXT_KEY]: 'id-a',
            },
            expected: [],
        },
    ];

    test.each(cases)('Should $description', ({ runtimeContext, expected }) => {
        expect(getResolvedConnectionIds(runtimeContext)).toEqual(expected);
    });
});
