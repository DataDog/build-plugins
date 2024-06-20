// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getPlugins } from '@dd/telemetry-plugins';
import { defaultPluginOptions, runBundlers } from '@dd/tests/helpers';

jest.mock('@dd/telemetry-plugins', () => {
    const originalModule = jest.requireActual('@dd/telemetry-plugins');
    return {
        ...originalModule,
        getPlugins: jest.fn(() => []),
    };
});

const getPluginsMocked = jest.mocked(getPlugins);

describe('Global Context Plugin', () => {
    test('It should inject context in the other plugins.', async () => {
        const pluginConfig = {
            ...defaultPluginOptions,
            telemetry: {},
        };

        await runBundlers(pluginConfig);

        // Confirm every call shares the options and the global context
        for (const call of getPluginsMocked.mock.calls) {
            expect(call[0]).toEqual(pluginConfig);
            expect(call[1]).toEqual({
                auth: expect.objectContaining({
                    apiKey: expect.any(String),
                }),
                bundler: {
                    name: expect.any(String),
                    config: expect.any(Object),
                },
                cwd: expect.any(String),
                version: expect.any(String),
            });
        }
    });
});
