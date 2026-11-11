// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    CONNECTIONS_CONTEXT_KEY,
    HAS_CONNECTION_ENVS_CONTEXT_KEY,
} from '@dd/apps-plugin/vite/local-execution-shared';

// Run against both the generated entry and local execution, so the two swaps can't drift apart.

const mapped = {
    [HAS_CONNECTION_ENVS_CONTEXT_KEY]: true,
    [CONNECTIONS_CONTEXT_KEY]: { jira: 'resolved-id' },
};
const noConfig = { [HAS_CONNECTION_ENVS_CONTEXT_KEY]: false, [CONNECTIONS_CONTEXT_KEY]: {} };

export const connectionLabelSwapCases: {
    description: string;
    runtimeContext: Record<string, unknown>;
    request: Record<string, unknown>;
    expected: Record<string, unknown>;
}[] = [
    {
        description: 'swap a mapped label for the resolved ID, ignoring the fallback',
        runtimeContext: mapped,
        request: { connectionLabel: 'jira', connectionId: 'fallback-id', inputs: {} },
        expected: { connectionId: 'resolved-id', inputs: {} },
    },
    {
        description: 'swap a label-only call',
        runtimeContext: mapped,
        request: { connectionLabel: 'jira', inputs: {} },
        expected: { connectionId: 'resolved-id', inputs: {} },
    },
    {
        description: 'use the fallback when the app has no config',
        runtimeContext: noConfig,
        request: { connectionLabel: 'jira', connectionId: 'fallback-id', inputs: {} },
        expected: { connectionId: 'fallback-id', inputs: {} },
    },
    {
        description: 'use the fallback when the server sent neither key',
        runtimeContext: {},
        request: { connectionLabel: 'jira', connectionId: 'fallback-id', inputs: {} },
        expected: { connectionId: 'fallback-id', inputs: {} },
    },
    {
        description: 'use the fallback when the server sent a map but no config flag',
        runtimeContext: { [CONNECTIONS_CONTEXT_KEY]: { jira: 'resolved-id' } },
        request: { connectionLabel: 'jira', connectionId: 'fallback-id', inputs: {} },
        expected: { connectionId: 'fallback-id', inputs: {} },
    },
    {
        description: 'use the fallback when the config flag is truthy but not true',
        runtimeContext: {
            [HAS_CONNECTION_ENVS_CONTEXT_KEY]: 'true',
            [CONNECTIONS_CONTEXT_KEY]: { jira: 'resolved-id' },
        },
        request: { connectionLabel: 'jira', connectionId: 'fallback-id', inputs: {} },
        expected: { connectionId: 'fallback-id', inputs: {} },
    },
    {
        description: 'leave a literal-only call unchanged',
        runtimeContext: mapped,
        request: { connectionId: 'literal-id', inputs: {} },
        expected: { connectionId: 'literal-id', inputs: {} },
    },
];

export const connectionLabelFailClosedCases: {
    description: string;
    runtimeContext: Record<string, unknown>;
    request: Record<string, unknown>;
    expectedError: string;
}[] = [
    {
        description: 'an unmapped label when the app has a config',
        runtimeContext: mapped,
        request: { connectionLabel: 'pagerduty', connectionId: 'fallback-id', inputs: {} },
        expectedError: 'Connection label "pagerduty" is not mapped in this connection environment',
    },
    {
        description: 'a label inherited from Object.prototype',
        runtimeContext: mapped,
        request: { connectionLabel: 'toString', connectionId: 'fallback-id', inputs: {} },
        expectedError: 'Connection label "toString" is not mapped in this connection environment',
    },
    {
        description: 'a label mapped to a non-string value',
        runtimeContext: {
            [HAS_CONNECTION_ENVS_CONTEXT_KEY]: true,
            [CONNECTIONS_CONTEXT_KEY]: { jira: 42 },
        },
        request: { connectionLabel: 'jira', connectionId: 'fallback-id', inputs: {} },
        expectedError: 'Connection label "jira" is not mapped in this connection environment',
    },
    {
        description: 'a label when the server sent a map that is not an object',
        runtimeContext: {
            [HAS_CONNECTION_ENVS_CONTEXT_KEY]: true,
            [CONNECTIONS_CONTEXT_KEY]: 'jira',
        },
        request: { connectionLabel: '0', connectionId: 'fallback-id', inputs: {} },
        expectedError: 'Connection label "0" is not mapped in this connection environment',
    },
    {
        description: 'a label when the app has a config but the server sent no map',
        runtimeContext: { [HAS_CONNECTION_ENVS_CONTEXT_KEY]: true },
        request: { connectionLabel: 'jira', connectionId: 'fallback-id', inputs: {} },
        expectedError: 'Connection label "jira" is not mapped in this connection environment',
    },
    {
        description: 'a label-only call when the app has no config',
        runtimeContext: noConfig,
        request: { connectionLabel: 'jira', inputs: {} },
        expectedError:
            'Connection label "jira" has no fallback connectionId and the app has no connection environment config',
    },
];
