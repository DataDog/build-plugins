// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { wrapPlugins, getResults } from '@dd/telemetry-plugin/esbuild-plugin/plugins';
import { getMockBuild } from '@dd/tests/unit/plugins/telemetry/testHelpers';
import type { PluginBuild, Plugin } from 'esbuild';

describe('Telemetry ESBuild Plugins', () => {
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

    test('Should wrap plugins', () => {
        expect(pluginMock.setup).toBe(pluginSetupMock);
        wrapPlugins(buildMock, '');
        expect(pluginMock.setup).not.toBe(pluginSetupMock);
    });

    test('Should return results', () => {
        wrapPlugins(buildMock, '');
        pluginMock.setup(buildMock);
        const results = getResults();
        expect(results.plugins).toBeDefined();
        expect(results.modules).toBeDefined();
    });
});
