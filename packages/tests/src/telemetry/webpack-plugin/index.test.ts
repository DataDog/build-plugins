// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { BuildPlugin } from '@datadog/webpack-plugin';
import { mockCompiler } from '@datadog/build-plugins-tests/testHelpers';

describe('webpack', () => {
    test(`It should use given context or default to webpack's configuration`, () => {
        const plugin1 = new BuildPlugin({
            context: '/fake/path',
        });
        const plugin2 = new BuildPlugin();

        const executePlugin = (plugin: BuildPlugin) => {
            plugin.apply(mockCompiler);
        };

        executePlugin(plugin1);
        executePlugin(plugin2);

        expect(plugin1.options.context).toBe('/fake/path');
        expect(plugin2.options.context).toBe('/default/context');
    });

    test('It should not execute if disabled', () => {
        const compiler = {
            hooks: {
                thisCompilation: {
                    tap: jest.fn(),
                },
            },
        };
        const plugin = new BuildPlugin({
            disabled: true,
        });

        // @ts-ignore
        plugin.apply(compiler);

        expect(compiler.hooks.thisCompilation.tap).not.toHaveBeenCalled();
    });
});
