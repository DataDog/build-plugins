// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getPlugins } from '@dd/rum-privacy-plugin';
import { getGetPluginsArg, getContextMock } from '@dd/tests/_jest/helpers/mocks';

describe('Rum Privacy Plugin', () => {
    describe('getPlugins', () => {
        test('Should not initialize the plugin if disabled', async () => {
            expect(getPlugins(getGetPluginsArg({ rumPrivacy: { disabled: true } }))).toHaveLength(
                0,
            );
            expect(
                getPlugins({ options: {}, context: getContextMock(), bundler: {} }),
            ).toHaveLength(0);
        });

        test('Should initialize the plugin if enabled', async () => {
            const injectMock = jest.fn();
            getPlugins(
                getGetPluginsArg(
                    {
                        rumPrivacy: {
                            disabled: false,
                        },
                    },
                    { inject: injectMock },
                ),
            );
            expect(injectMock).toHaveBeenCalled();
        });
    });
});
