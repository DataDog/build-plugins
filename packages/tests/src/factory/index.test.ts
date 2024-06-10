// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getPlugins } from '@dd/telemetry-plugins';
import fs from 'fs';
import path from 'path';

import { runBundlers } from '../helpers';

jest.mock('@dd/telemetry-plugins', () => {
    const originalModule = jest.requireActual('@dd/telemetry-plugins');
    return {
        ...originalModule,
        getPlugins: jest.fn(() => []),
    };
});

const entry = '@dd/tests/fixtures/index.js';
const destination = path.resolve(__dirname, './fixtures/dist');
const getPluginsMocked = jest.mocked(getPlugins);

describe('Factory', () => {
    afterEach(() => {
        // Clean files
        fs.rmSync(destination, {
            recursive: true,
            force: true,
        });
    });
    test('It should not call a disabled plugin', async () => {
        await runBundlers({ entry, destination }, { telemetry: { disabled: true } });
        expect(getPluginsMocked).not.toHaveBeenCalled();
    });
    test('It should call an enabled plugin', async () => {
        const results = await runBundlers(
            { entry, destination },
            { telemetry: { disabled: false } },
        );
        expect(getPluginsMocked).toHaveBeenCalledTimes(results.length);
    });
});
