// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { RumOptions } from '@dd/rum-plugin/types';
import { getPlugins } from '@dd/rum-plugin';
import {
    defaultPluginOptions,
    getContextMock,
    getGetPluginsArg,
} from '@dd/tests/_jest/helpers/mocks';
import path from 'path';

// Mock getInjectionvalue @dd/rum-plugin/sdk to return a given string.
const injectionValue = 'DD_RUM INITIALIZATION';
jest.mock('@dd/rum-plugin/sdk', () => ({
    getInjectionValue: jest.fn(() => injectionValue),
}));

describe('RUM Plugin', () => {
    const injections = {
        'browser-sdk': path.resolve('../plugins/rum/src/rum-browser-sdk.js'),
        'sdk-init': injectionValue,
    };

    const expectations: {
        type: string;
        config: RumOptions;
        should: { inject: (keyof typeof injections)[]; throw?: boolean };
    }[] = [
        {
            type: 'no sdk',
            config: {},
            should: { inject: [] },
        },
        {
            type: 'sdk',
            config: { sdk: { applicationId: 'app-id' } },
            should: { inject: ['browser-sdk', 'sdk-init'] },
        },
    ];
    describe('getPlugins', () => {
        const injectMock = jest.fn();
        test('Should not initialize the plugin if disabled', async () => {
            getPlugins(
                getGetPluginsArg(
                    {
                        rum: {
                            enable: false,
                            sdk: { applicationId: 'app-id', clientToken: '123' },
                        },
                    },
                    { inject: injectMock },
                ),
            );
            getPlugins(getGetPluginsArg({}, { inject: injectMock }));
            expect(injectMock).not.toHaveBeenCalled();
        });

        test('Should initialize the plugin if enabled', async () => {
            getPlugins(
                getGetPluginsArg(
                    {
                        rum: {
                            enable: true,
                            sdk: { applicationId: 'app-id', clientToken: '123' },
                        },
                    },
                    { inject: injectMock },
                ),
            );
            expect(injectMock).toHaveBeenCalled();
        });
    });

    test.each(expectations)(
        'Should inject the necessary files with "$type".',
        async ({ config, should }) => {
            const mockContext = getContextMock();
            const pluginConfig = { ...defaultPluginOptions, rum: config };

            const expectResult = expect(() => {
                getPlugins(getGetPluginsArg(pluginConfig, mockContext));
            });

            if (should.throw) {
                expectResult.toThrow();
            } else {
                expectResult.not.toThrow();
            }

            expect(mockContext.inject).toHaveBeenCalledTimes(should.inject.length);
            for (const inject of should.inject) {
                expect(mockContext.inject).toHaveBeenCalledWith(
                    expect.objectContaining({
                        value: injections[inject],
                    }),
                );
            }
        },
    );
});
