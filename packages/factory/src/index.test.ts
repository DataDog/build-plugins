// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginOptions, Options } from '@dd/core/types';
import { PLUGIN_NAME as ERROR_TRACKING_PLUGIN_NAME } from '@dd/error-tracking-plugin';
import { getUnsupportedViteWarning } from '@dd/factory/helpers/vite-version';
import { buildPluginFactory } from '@dd/factory';

const invokeFactory = (opts: Options): PluginOptions[] => {
    const factory = buildPluginFactory({ bundler: {}, version: '1.0.0' });
    return factory.raw(opts, { framework: 'esbuild' }) as PluginOptions[];
};

const hasPlugin = (plugins: PluginOptions[], name: string) =>
    plugins.some((plugin) => plugin.name.includes(name));

describe('Factory', () => {
    test('Should not throw with no options', () => {
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

        test('Should skip a plugin when its config key is absent', () => {
            const plugins = invokeFactory({ logLevel: 'none' });
            expect(hasPlugin(plugins, 'output')).toBe(false);
            expect(hasPlugin(plugins, 'metrics')).toBe(false);
            expect(hasPlugin(plugins, 'rum')).toBe(false);
        });

        test('Should include a plugin when its config key is present', () => {
            const plugins = invokeFactory({ logLevel: 'none', output: {} });
            expect(hasPlugin(plugins, 'output')).toBe(true);
        });

        test('Should skip a plugin when enable: false', () => {
            const plugins = invokeFactory({
                logLevel: 'none',
                output: { enable: false },
            });
            expect(hasPlugin(plugins, 'output')).toBe(false);
        });

        test('Should include a plugin when enable: true', () => {
            const plugins = invokeFactory({
                logLevel: 'none',
                output: { enable: true },
            });
            expect(hasPlugin(plugins, 'output')).toBe(true);
        });

        test('Should include error tracking for RUM debug ID uploads', () => {
            const plugins = invokeFactory({
                auth: { apiKey: '123' },
                errorTracking: { sourcemaps: { debugId: true } },
                logLevel: 'none',
                rum: { sourceCodeContext: { debugId: true } },
            });
            expect(hasPlugin(plugins, ERROR_TRACKING_PLUGIN_NAME)).toBe(true);
        });

        test('Should not upload from the top-level sourcemaps option by default', () => {
            const plugins = invokeFactory({
                logLevel: 'none',
                sourcemaps: { debugId: true },
            });
            expect(hasPlugin(plugins, ERROR_TRACKING_PLUGIN_NAME)).toBe(false);
        });

        test('Should inject and upload debug ID source maps from the top-level sourcemaps option', () => {
            const plugins = invokeFactory({
                auth: { apiKey: '123' },
                logLevel: 'none',
                sourcemaps: { debugId: true, upload: true },
            });
            expect(hasPlugin(plugins, ERROR_TRACKING_PLUGIN_NAME)).toBe(true);
        });

        test('Should coerce a non-boolean enable value and still include the plugin', () => {
            const plugins = invokeFactory({
                logLevel: 'none',
                // @ts-expect-error - intentional non-boolean to exercise coercion
                output: { enable: 1 },
            });
            expect(hasPlugin(plugins, 'output')).toBe(true);
        });
    });

    describe('Vite version', () => {
        let warn: jest.SpyInstance;

        beforeEach(() => {
            warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        });

        afterEach(() => {
            warn.mockRestore();
        });

        const cases: {
            description: string;
            framework: 'vite' | 'esbuild';
            version: string;
            warns: boolean;
        }[] = [
            { description: 'Vite 5', framework: 'vite', version: '5.4.21', warns: true },
            { description: 'Vite 6.3', framework: 'vite', version: '6.3.5', warns: true },
            { description: 'Vite 6.4', framework: 'vite', version: '6.4.3', warns: false },
            { description: 'Vite 8', framework: 'vite', version: '8.3.4', warns: false },
            { description: 'Vite 9', framework: 'vite', version: '9.0.0', warns: true },
            {
                description: 'another bundler with a low version',
                framework: 'esbuild',
                version: '0.25.8',
                warns: false,
            },
        ];

        test.each(cases)(
            'Should warn about an unsupported Vite only when it is one: $description',
            ({ framework, version, warns }) => {
                const factory = buildPluginFactory({ bundler: { version }, version: '1.0.0' });
                factory.raw({ logLevel: 'warn' }, { framework });
                const warnings = warn.mock.calls.map(([message]) => String(message));
                const viteWarnings = warnings.filter((message) =>
                    message.includes("Datadog's Vite plugin"),
                );
                const expected = getUnsupportedViteWarning(version);
                const matching = viteWarnings.filter(
                    (message) => expected !== undefined && message.endsWith(expected),
                );
                const count = warns ? 1 : 0;
                expect(viteWarnings).toHaveLength(count);
                expect(matching).toHaveLength(count);
            },
        );

        test('Should not print the warning when logs are off', () => {
            const factory = buildPluginFactory({
                bundler: { version: '5.4.21' },
                version: '1.0.0',
            });
            factory.raw({ logLevel: 'none' }, { framework: 'vite' });
            expect(warn).not.toHaveBeenCalled();
        });
    });
});
