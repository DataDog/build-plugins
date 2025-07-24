// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getPlugins } from '@dd/rum-plugin';
import { getGetPluginsArg } from '@dd/tests/_jest/helpers/mocks';

import { buildTransformOptions } from './transform';

jest.mock('./transform', () => {
    const original = jest.requireActual('./transform');
    return {
        // We don't want to modify anything else on the module.
        ...original,
        buildTransformOptions: jest.fn(),
    };
});
const mockBuildTransformOptions = jest.mocked(buildTransformOptions);

describe('Rum Privacy Plugin', () => {
    describe('getPlugins', () => {
        beforeEach(() => {
            jest.clearAllMocks();
        });

        test('Should not initialize the plugin if not enabled', async () => {
            expect(
                getPlugins(
                    getGetPluginsArg({
                        rum: {
                            // privacy plugin isdisabled without the privacy option
                        },
                    }),
                ),
            ).toHaveLength(0);
            expect(mockBuildTransformOptions).not.toHaveBeenCalled();
        });

        test('Should initialize the plugin and call buildTransformOptions if enabled', async () => {
            getPlugins(
                getGetPluginsArg({
                    rum: {
                        privacy: {
                            exclude: [],
                            include: [],
                        },
                    },
                }),
            );
            expect(mockBuildTransformOptions).toHaveBeenCalled();
        });
    });
});
