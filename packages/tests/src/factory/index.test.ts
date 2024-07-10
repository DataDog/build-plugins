// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getPlugins } from '@dd/telemetry-plugins';
import { runBundlers } from '@dd/tests/helpers/runBundlers';

jest.mock('@dd/telemetry-plugins', () => {
    const originalModule = jest.requireActual('@dd/telemetry-plugins');
    return {
        ...originalModule,
        getPlugins: jest.fn(() => []),
    };
});

const getPluginsMocked = jest.mocked(getPlugins);

describe('Factory', () => {
    test('It should not call a disabled plugin', async () => {
        await runBundlers({ telemetry: { disabled: true } });
        expect(getPluginsMocked).not.toHaveBeenCalled();
    });

    test('It should call an enabled plugin', async () => {
        const results = await runBundlers({ telemetry: { disabled: false } });
        expect(getPluginsMocked).toHaveBeenCalledTimes(results.length);
    });
});
