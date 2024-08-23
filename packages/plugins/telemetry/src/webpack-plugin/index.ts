// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext } from '@dd/core/types';
import type { UnpluginOptions } from 'unplugin';

import { PLUGIN_NAME } from '../constants';
import type { Compilation, BundlerContext } from '../types';

import { Loaders } from './loaders';
import { Modules } from './modules';
import { Tapables } from './tapables';

export const getWebpackPlugin = (
    bundlerContext: BundlerContext,
    globalContext: GlobalContext,
): UnpluginOptions['webpack'] => {
    return async (compiler) => {
        globalContext.build.start = Date.now();

        const HOOK_OPTIONS = { name: PLUGIN_NAME };

        const modules = new Modules(globalContext.cwd);
        const tapables = new Tapables(globalContext.cwd);
        const loaders = new Loaders(globalContext.cwd);

        // @ts-expect-error - webpack 4 and 5 nonsense.
        tapables.throughHooks(compiler);

        // @ts-expect-error - webpack 4 and 5 nonsense.
        compiler.hooks.thisCompilation.tap(HOOK_OPTIONS, (compilation: Compilation) => {
            tapables.throughHooks(compilation);

            compilation.hooks.buildModule.tap(HOOK_OPTIONS, (module) => {
                loaders.buildModule(module, compilation);
            });

            compilation.hooks.succeedModule.tap(HOOK_OPTIONS, (module) => {
                loaders.succeedModule(module, compilation);
            });

            compilation.hooks.afterOptimizeTree.tap(HOOK_OPTIONS, (chunks, mods) => {
                modules.afterOptimizeTree(chunks, mods, compilation);
            });
        });

        // We're losing some tracing from plugins by using `afterEmit` instead of `done` but
        // it allows us to centralize the common process better.
        compiler.hooks.afterEmit.tapPromise(HOOK_OPTIONS, async (compilation) => {
            const { timings: tapableTimings } = tapables.getResults();
            const { loaders: loadersTimings, modules: modulesTimings } = loaders.getResults();
            // Rewrite this to use the stats file instead.
            const { modules: modulesDeps } = modules.getResults();

            bundlerContext.report = {
                timings: {
                    tapables: tapableTimings,
                    loaders: loadersTimings,
                    modules: modulesTimings,
                },
                dependencies: modulesDeps,
            };
        });
    };
};
