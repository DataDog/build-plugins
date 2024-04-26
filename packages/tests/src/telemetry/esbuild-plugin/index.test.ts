// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import esbuildPlugin from '@datadog/esbuild-plugin';
import type { PluginBuild } from 'esbuild';
import esbuild from 'esbuild';

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
    test('It should not execute if disabled', () => {
        const plugin = esbuildPlugin({
            auth: {
                apiKey: '',
                appKey: '',
            },
            telemetry: { disabled: true },
        });

        plugin.setup(mockBuild);

        expect(mockBuild.onEnd).not.toHaveBeenCalled();
    });
});