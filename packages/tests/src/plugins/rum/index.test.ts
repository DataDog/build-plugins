// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { RumOptions } from '@dd/rum-plugin/types';
import { getPlugins } from '@dd/rum-plugin';
import { defaultPluginOptions, getContextMock, mockLogger } from '@dd/tests/_jest/helpers/mocks';
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
        'rum-react-plugin': path.resolve('../plugins/rum/src/rum-react-plugin.js'),
    };

    const expectations: {
        type: string;
        config: RumOptions;
        should: { inject?: (keyof typeof injections)[]; throw?: boolean };
    }[] = [
        {
            type: 'no sdk and no react',
            config: {},
            should: { inject: [] },
        },
        {
            type: 'sdk and no react',
            config: { sdk: { applicationId: 'app-id' } },
            should: { inject: ['browser-sdk', 'sdk-init'] },
        },
        {
            type: 'sdk and react',
            config: { sdk: { applicationId: 'app-id' }, react: { router: true } },
            should: { inject: ['browser-sdk', 'sdk-init', 'rum-react-plugin'] },
        },
        {
            type: 'no sdk and react',
            config: { react: { router: true } },
            should: { throw: true },
        },
    ];

    test.each(expectations)(
        'Should inject the necessary files with "$type".',
        async ({ config, should }) => {
            const mockContext = getContextMock();
            const pluginConfig = { ...defaultPluginOptions, rum: config };

            const expectResult = expect(() => {
                getPlugins(pluginConfig, mockContext, mockLogger);
            });

            if (should.throw) {
                expectResult.toThrow();
            } else {
                expectResult.not.toThrow();
            }

            if (should.inject) {
                expect(mockContext.inject).toHaveBeenCalledTimes(should.inject.length);
                for (const inject of should.inject) {
                    expect(mockContext.inject).toHaveBeenCalledWith(
                        expect.objectContaining({
                            value: injections[inject],
                        }),
                    );
                }
            }
        },
    );
});
