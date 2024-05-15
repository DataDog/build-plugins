// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
import { wrapPlugins, getResults } from '@dd/telemetry-plugins/esbuild-plugin/plugins';
import { getMockBuild } from '@dd/tests/testHelpers';
import type { PluginBuild, Plugin } from 'esbuild';

describe('esbuild plugins', () => {
    let pluginSetupMock: (build: PluginBuild) => void | Promise<void>;
    let pluginMock: Plugin;
    let buildMock: PluginBuild;

    beforeEach(() => {
        pluginSetupMock = jest.fn();
        pluginMock = {
            name: 'Plugin1',
            setup: pluginSetupMock,
        };
        buildMock = getMockBuild({
            initialOptions: {
                plugins: [pluginMock],
            },
        });
    });

    test('It should wrap plugins', () => {
        expect(pluginMock.setup).toBe(pluginSetupMock);
        wrapPlugins(buildMock, '');
        expect(pluginMock.setup).not.toBe(pluginSetupMock);
    });

    test('It should return results', () => {
        wrapPlugins(buildMock, '');
        pluginMock.setup(buildMock);
        const results = getResults();
        expect(results.plugins).toBeDefined();
        expect(results.modules).toBeDefined();
    });
});
