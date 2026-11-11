// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, rm } from '@dd/core/helpers/fs';
import { clearDatadogEnv } from '@dd/tests/_jest/helpers/datadogEnv';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { APP_CONFIG_FILE, readAppIdentity, readConnectionEnvId } from './app-identity';

describe('readAppIdentity', () => {
    let restoreEnv: () => void;
    let projectRoot: string;

    beforeEach(async () => {
        restoreEnv = clearDatadogEnv();
        projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dd-apps-identity-'));
    });

    afterEach(async () => {
        restoreEnv();
        await rm(projectRoot);
    });

    const cases: {
        description: string;
        config?: string;
        env?: Record<string, string>;
        expected: { identifier?: string; name?: string };
    }[] = [
        {
            description: 'read the id and name from the app config, trimmed',
            config: '{"id": " 5cf28549-4f3f-432b-9039-bc841ed2b1e1 ", "name": " My App "}',
            expected: { identifier: '5cf28549-4f3f-432b-9039-bc841ed2b1e1', name: 'My App' },
        },
        {
            description: 'return no identity without an app config',
            expected: { identifier: undefined, name: undefined },
        },
        {
            description: 'return no identity for an app config that is not valid JSON',
            config: '{"id": ',
            expected: { identifier: undefined, name: undefined },
        },
        {
            description: 'return no identity for an app config that is not an object',
            config: '["5cf28549-4f3f-432b-9039-bc841ed2b1e1"]',
            expected: { identifier: undefined, name: undefined },
        },
        {
            description: 'ignore values that are not strings or are blank',
            config: '{"id": 123, "name": "  "}',
            expected: { identifier: undefined, name: undefined },
        },
        {
            description: 'prefer the identity the environment sets over the app config',
            config: '{"id": "from-config", "name": "Config Name"}',
            env: { DATADOG_APPS_IDENTIFIER: ' from-env ', DD_APPS_NAME: 'Env Name' },
            expected: { identifier: 'from-env', name: 'Env Name' },
        },
        {
            description: 'read the identity from the environment alone',
            env: { DD_APPS_IDENTIFIER: 'from-env', DATADOG_APPS_NAME: 'Env Name' },
            expected: { identifier: 'from-env', name: 'Env Name' },
        },
        {
            description: 'prefer DATADOG_ over DD_ variables',
            env: { DATADOG_APPS_IDENTIFIER: 'datadog', DD_APPS_IDENTIFIER: 'dd' },
            expected: { identifier: 'datadog', name: undefined },
        },
        {
            description: 'fall back to the app config when the environment value is blank',
            config: '{"id": "from-config", "name": "Config Name"}',
            env: { DATADOG_APPS_IDENTIFIER: '  ', DATADOG_APPS_NAME: ' ' },
            expected: { identifier: 'from-config', name: 'Config Name' },
        },
    ];

    test.each(cases)('Should $description', async ({ config, env, expected }) => {
        if (config !== undefined) {
            const configPath = path.join(projectRoot, APP_CONFIG_FILE);
            await outputFile(configPath, config);
        }
        Object.assign(process.env, env);

        const identity = readAppIdentity(projectRoot, getMockLogger());

        expect(identity).toEqual(expected);
    });
});

describe('readConnectionEnvId', () => {
    let restoreEnv: () => void;

    beforeEach(() => {
        restoreEnv = clearDatadogEnv();
    });

    afterEach(() => {
        restoreEnv();
    });

    const cases: { description: string; env: Record<string, string>; expected?: string }[] = [
        {
            description: 'return nothing when no environment is selected',
            env: {},
            expected: undefined,
        },
        {
            description: 'read the selected environment, trimmed',
            env: { DD_APPS_CONNECTION_ENV_ID: ' env-id ' },
            expected: 'env-id',
        },
        {
            description: 'prefer DATADOG_ over DD_',
            env: { DATADOG_APPS_CONNECTION_ENV_ID: 'datadog', DD_APPS_CONNECTION_ENV_ID: 'dd' },
            expected: 'datadog',
        },
        {
            description: 'treat a blank value as no selection',
            env: { DD_APPS_CONNECTION_ENV_ID: '  ' },
            expected: undefined,
        },
    ];

    test.each(cases)('Should $description', ({ env, expected }) => {
        Object.assign(process.env, env);

        expect(readConnectionEnvId()).toBe(expected);
    });
});
