// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginOptions, Options } from '@dd/core/types';

const invokeFactory = async (opts: Options): Promise<PluginOptions[]> => {
    const { buildPluginFactory } = await import('@dd/factory');
    const factory = buildPluginFactory({ bundler: {}, version: '1.0.0' });
    return factory.raw(opts, { framework: 'esbuild' }) as PluginOptions[];
};

const hasPlugin = (plugins: PluginOptions[], name: string) =>
    plugins.some((plugin) => plugin.name.includes(name));

describe('Factory', () => {
    test('Should not throw with no options', async () => {
        const { buildPluginFactory } = await import('@dd/factory');
        expect(() => {
            const factory = buildPluginFactory({ bundler: {}, version: '1.0.0' });
            // Vite could call the factory without options.
            // @ts-expect-error - We are testing the factory without options.
            factory.vite();
        }).not.toThrow();
    });

    describe('enable gating for user-facing plugins', () => {
        // The factory is the single source of truth for `<configKey>.enable`.
        // Each user-facing plugin is skipped when its config key is absent or
        // explicitly disabled, and included when the config key is present.

        test('Should skip a plugin when its config key is absent', async () => {
            const plugins = await invokeFactory({ logLevel: 'none' });
            expect(hasPlugin(plugins, 'output')).toBe(false);
            expect(hasPlugin(plugins, 'metrics')).toBe(false);
            expect(hasPlugin(plugins, 'rum')).toBe(false);
        });

        test('Should include a plugin when its config key is present', async () => {
            const plugins = await invokeFactory({ logLevel: 'none', output: {} });
            expect(hasPlugin(plugins, 'output')).toBe(true);
        });

        test('Should skip a plugin when enable: false', async () => {
            const plugins = await invokeFactory({
                logLevel: 'none',
                output: { enable: false },
            });
            expect(hasPlugin(plugins, 'output')).toBe(false);
        });

        test('Should include a plugin when enable: true', async () => {
            const plugins = await invokeFactory({
                logLevel: 'none',
                output: { enable: true },
            });
            expect(hasPlugin(plugins, 'output')).toBe(true);
        });

        test('Should coerce a non-boolean enable value and still include the plugin', async () => {
            const plugins = await invokeFactory({
                logLevel: 'none',
                // @ts-expect-error - intentional non-boolean to exercise coercion
                output: { enable: 1 },
            });
            expect(hasPlugin(plugins, 'output')).toBe(true);
        });
    });
});
