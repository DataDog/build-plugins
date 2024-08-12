// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
import type { Logger } from '@dd/core/log';
import type { GlobalContext } from '@dd/core/types';
import type { UnpluginOptions } from 'unplugin';

import { output } from '../common/output';
import { sendMetrics } from '../common/sender';
import { PLUGIN_NAME } from '../constants';
import type { Compilation, Stats, BundlerContext, TelemetryOptions } from '../types';

import { Loaders } from './loaders';
import { Modules } from './modules';
import { Tapables } from './tapables';

export const getWebpackPlugin = (
    bundlerContext: BundlerContext,
    globalContext: GlobalContext,
    telemetryOptions: TelemetryOptions,
    logger: Logger,
): UnpluginOptions['webpack'] => {
    return async (compiler) => {
        globalContext.build.start = Date.now();
        let realBuildEnd: number = 0;

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

        compiler.hooks.emit.tapPromise(HOOK_OPTIONS, async () => {
            realBuildEnd = Date.now();
        });

        // @ts-expect-error - webpack 4 and 5 nonsense.
        compiler.hooks.done.tapPromise(HOOK_OPTIONS, async (stats: Stats) => {
            globalContext.build.end = Date.now();
            globalContext.build.duration = globalContext.build.end - globalContext.build.start!;
            globalContext.build.writeDuration = globalContext.build.end - realBuildEnd;

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
            bundlerContext.bundler = { webpack: stats };

            await output(bundlerContext, globalContext, telemetryOptions, logger);
            await sendMetrics(
                bundlerContext.metrics,
                { apiKey: globalContext.auth?.apiKey, endPoint: telemetryOptions.endPoint },
                logger,
            );
        });
    };
};
