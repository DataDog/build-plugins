// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getPlugins } from '@dd/rum-privacy-plugin';
import { getGetPluginsArg } from '@dd/tests/_jest/helpers/mocks';

import * as transform from './transform';

jest.mock('./transform', () => ({
    buildTransformOptions: jest.fn(),
}));

describe('Rum Privacy Plugin', () => {
    describe('getPlugins', () => {
        beforeEach(() => {
            jest.clearAllMocks();
        });

        test('Should not initialize the plugin if disabled', async () => {
            expect(
                getPlugins(
                    getGetPluginsArg({
                        rumPrivacy: {
                            disabled: true,
                            exclude: [],
                            include: [],
                            module: 'esm',
                            jsx: undefined,
                            transformStrategy: 'ast',
                            typescript: undefined,
                        },
                    }),
                ),
            ).toHaveLength(0);
            expect(transform.buildTransformOptions).not.toHaveBeenCalled();
        });

        test('Should initialize the plugin and call buildTransformOptions if enabled', async () => {
            getPlugins(
                getGetPluginsArg({
                    rumPrivacy: {
                        disabled: false,
                        exclude: [],
                        include: [],
                        module: 'esm',
                        jsx: undefined,
                        transformStrategy: 'ast',
                        typescript: undefined,
                    },
                }),
            );
            expect(transform.buildTransformOptions).toHaveBeenCalled();
        });
    });
});
