// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, PluginOptions } from '@dd/core/types';
import { PLUGIN_NAME } from '@dd/metrics-plugin/constants';
import type { Compilation, BundlerContext } from '@dd/metrics-plugin/types';

import { Loaders } from './loaders';
import { Tapables } from './tapables';

export const getWebpackPlugin = (
    bundlerContext: BundlerContext,
    globalContext: GlobalContext,
): PluginOptions['webpack'] & PluginOptions['rspack'] => {
    return async (compiler) => {
        const log = globalContext.getLogger(PLUGIN_NAME);

        const HOOK_OPTIONS = { name: PLUGIN_NAME };

        const tapables = new Tapables(globalContext.buildRoot);
        const loaders = new Loaders(globalContext.buildRoot);

        const compilerTime = log.time('parse compiler hooks');
        // @ts-expect-error - webpack and rspack reconciliation.
        tapables.throughHooks(compiler);
        compilerTime.end();

        // @ts-expect-error - webpack and rspack reconciliation.
        compiler.hooks.thisCompilation.tap(HOOK_OPTIONS, (compilation: Compilation) => {
            const compilationTime = log.time('parse compilation hooks');
            tapables.throughHooks(compilation);
            compilationTime.end();

            // TODO: Use log.time() to measure modules.
            compilation.hooks.buildModule.tap(HOOK_OPTIONS, (module) => {
                loaders.startModule(module, compilation);
            });

            compilation.hooks.succeedModule.tap(HOOK_OPTIONS, (module) => {
                loaders.doneModule(module, compilation);
            });

            // NOTE: compilation.hooks.failedModule is not available in rspack as of 1.2.8
            // https://rspack.dev/api/plugin-api/compilation-hooks
            if (compilation.hooks.failedModule) {
                compilation.hooks.failedModule.tap(HOOK_OPTIONS, (module) => {
                    loaders.doneModule(module, compilation);
                });
            }
        });

        // We're losing some tracing from plugins by using `afterEmit` instead of `done` but
        // it allows us to centralize the common process better.
        // TODO: Use custom hooks to make this more reliable and not blocked by a race condition.
        compiler.hooks.afterEmit.tap(HOOK_OPTIONS, () => {
            const { timings: tapableTimings } = tapables.getResults();
            const { loaders: loadersTimings, modules: modulesTimings } = loaders.getResults();

            bundlerContext.report = {
                timings: {
                    tapables: tapableTimings,
                    loaders: loadersTimings,
                    modules: modulesTimings,
                },
            };
        });
    };
};
