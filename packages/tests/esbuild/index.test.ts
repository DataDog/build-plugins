// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { BuildPluginClass } from '@datadog/esbuild-plugin';
import esbuild, { PluginBuild } from 'esbuild';

const mockBuild: PluginBuild = {
    initialOptions: {},
    esbuild,
    resolve: jest.fn(),
    onStart: jest.fn(),
    onEnd: jest.fn(),
    onResolve: jest.fn(),
    onDispose: jest.fn(),
    onLoad: jest.fn(),
};

describe('esbuild', () => {
    test(`It should use given context or default to current working directory`, () => {
        const plugin1 = new BuildPluginClass({
            context: '/fake/path',
        });
        const plugin2 = new BuildPluginClass({});

        const executePlugin = (plugin: BuildPluginClass) => {
            plugin.setup(mockBuild);
        };

        executePlugin(plugin1);
        executePlugin(plugin2);

        expect(plugin1.options.context).toBe('/fake/path');
        expect(plugin2.options.context).toBe(process.cwd());
    });

    test('It should not execute if disabled', () => {
        const plugin = new BuildPluginClass({
            disabled: true,
        });

        plugin.setup(mockBuild);

        expect(mockBuild.onEnd).not.toHaveBeenCalled();
    });
});
