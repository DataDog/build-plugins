// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getPlugins } from '@dd/telemetry-plugin';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';

jest.mock('@dd/telemetry-plugin', () => {
    const originalModule = jest.requireActual('@dd/telemetry-plugin');
    return {
        ...originalModule,
        getPlugins: jest.fn(() => []),
    };
});

const getPluginsMocked = jest.mocked(getPlugins);

describe('Factory', () => {
    test('Should not throw with no options', async () => {
        const { buildPluginFactory } = await import('@dd/factory');
        expect(() => {
            const factory = buildPluginFactory({ bundler: {}, version: '1.0.0' });
            // Vite could call the factory without options.
            // @ts-expect-error - We are testing the factory without options.
            factory.vite();
        }).not.toThrow();
    });

    test('Should not call a disabled plugin', async () => {
        await runBundlers({ telemetry: { disabled: true } });
        expect(getPluginsMocked).not.toHaveBeenCalled();
    });

    test('Should call an enabled plugin', async () => {
        await runBundlers({ telemetry: { disabled: false } });
        expect(getPluginsMocked).toHaveBeenCalledTimes(BUNDLERS.length);
    });
});
