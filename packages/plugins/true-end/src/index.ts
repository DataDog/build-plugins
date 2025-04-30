// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetInternalPlugins, GetPluginsArg, PluginOptions, PluginName } from '@dd/core/types';

export const PLUGIN_NAME: PluginName = 'datadog-true-end-plugin' as const;

export const getTrueEndPlugins: GetInternalPlugins = (arg: GetPluginsArg) => {
    const { context } = arg;
    const asyncHookFn = async () => {
        await context.asyncHook('asyncTrueEnd');
    };
    const syncHookFn = () => {
        context.hook('syncTrueEnd');
    };
    const bothHookFns = async () => {
        syncHookFn();
        await asyncHookFn();
    };

    const xpackPlugin: PluginOptions['rspack'] & PluginOptions['webpack'] = (compiler) => {
        if (compiler.hooks.shutdown) {
            // NOTE: rspack prior to 1.2.* will randomly crash on shutdown.tapPromise.
            compiler.hooks.shutdown.tapPromise(PLUGIN_NAME, bothHookFns);
        } else {
            // Webpack 4 only.
            compiler.hooks.done.tapPromise(PLUGIN_NAME, bothHookFns);
            compiler.hooks.failed.tap(PLUGIN_NAME, syncHookFn);
        }
    };

    const rollupPlugin: PluginOptions['rollup'] & PluginOptions['vite'] = {
        async writeBundle() {
            // TODO: Need to fallback here in case the closeBundle isn't called.
        },
        async closeBundle() {
            await bothHookFns();
        },
    };

    return [
        {
            name: PLUGIN_NAME,
            webpack: xpackPlugin,
            esbuild: {
                setup(build) {
                    build.onEnd(async () => {
                        asyncHookFn();
                    });
                    // NOTE: "onDispose" is strictly synchronous.
                    build.onDispose(() => {
                        syncHookFn();
                    });
                },
            },
            vite: rollupPlugin,
            rollup: rollupPlugin,
            rspack: xpackPlugin,
        },
    ];
};
