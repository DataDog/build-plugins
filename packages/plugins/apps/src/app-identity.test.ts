// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, rm } from '@dd/core/helpers/fs';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { APP_CONFIG_FILE, readAppIdentity } from './app-identity';

describe('readAppIdentity', () => {
    let projectRoot: string;

    beforeEach(async () => {
        projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dd-apps-identity-'));
    });

    afterEach(async () => {
        await rm(projectRoot);
    });

    const cases: {
        description: string;
        config?: string;
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
    ];

    test.each(cases)('Should $description', async ({ config, expected }) => {
        if (config !== undefined) {
            const configPath = path.join(projectRoot, APP_CONFIG_FILE);
            await outputFile(configPath, config);
        }

        const identity = readAppIdentity(projectRoot, getMockLogger());

        expect(identity).toEqual(expected);
    });
});
