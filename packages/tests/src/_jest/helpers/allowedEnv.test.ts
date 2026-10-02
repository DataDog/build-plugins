// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { scrubEnv } from './allowedEnv';

describe('scrubEnv', () => {
    const cases = [
        { description: 'keep PATH', name: 'PATH', kept: true },
        { description: 'keep HOME, which git needs', name: 'HOME', kept: true },
        {
            description: 'keep NODE_OPTIONS, which carries preloads',
            name: 'NODE_OPTIONS',
            kept: true,
        },
        { description: 'keep Jest variables', name: 'JEST_WORKER_ID', kept: true },
        { description: 'keep locale variables', name: 'LC_ALL', kept: true },
        { description: 'keep test runner flags', name: 'REQUESTED_BUNDLERS', kept: true },
        {
            description: 'keep the service dd-trace tags tests with',
            name: 'DD_SERVICE',
            kept: true,
        },
        { description: 'keep the tags dd-trace adds to tests', name: 'DD_TAGS', kept: true },
        {
            description: 'keep dd-trace CI Visibility config',
            name: 'DD_CIVISIBILITY_AGENTLESS_ENABLED',
            kept: true,
        },
        {
            description: 'keep the GitHub run dd-trace links tests to',
            name: 'GITHUB_RUN_ID',
            kept: true,
        },
        { description: 'keep the GitHub event path', name: 'GITHUB_EVENT_PATH', kept: true },
        {
            description: 'keep the runner temp dir dd-trace finds job IDs in',
            name: 'RUNNER_TEMP',
            kept: true,
        },
        { description: 'keep dd-trace tracer config', name: 'DD_TRACE_DEBUG', kept: true },
        {
            description: 'keep debugger attach options',
            name: 'VSCODE_INSPECTOR_OPTIONS',
            kept: true,
        },
        { description: 'keep coverage output config', name: 'NODE_V8_COVERAGE', kept: true },
        { description: 'remove the Datadog API key', name: 'DD_API_KEY', kept: false },
        { description: 'remove the legacy Datadog API key', name: 'DATADOG_API_KEY', kept: false },
        { description: 'remove the Datadog app key', name: 'DD_APP_KEY', kept: false },
        { description: 'remove DD_SITE, which plugins read', name: 'DD_SITE', kept: false },
        { description: 'remove a GitHub token', name: 'GITHUB_TOKEN', kept: false },
        {
            description: 'remove the GitHub OIDC request token',
            name: 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
            kept: false,
        },
        { description: 'remove an npm auth token', name: 'npm_config__authToken', kept: false },
        { description: 'remove a Node auth token', name: 'NODE_AUTH_TOKEN', kept: false },
        { description: 'remove the SSH agent socket', name: 'SSH_AUTH_SOCK', kept: false },
        { description: 'remove a name that only starts like a prefix', name: 'JEST', kept: false },
        { description: 'remove an unknown variable', name: 'SCRUB_ENV_TEST_UNKNOWN', kept: false },
    ];

    test.each(cases)('Should $description', ({ name, kept }) => {
        const previousValue = process.env[name];
        process.env[name] = 'value';

        scrubEnv();
        const isKept = name in process.env;

        if (previousValue === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = previousValue;
        }
        expect(isKept).toBe(kept);
    });
});
