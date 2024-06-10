// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getLogger } from '@dd/core/log';
import type { Context as GlobalContext } from '@dd/core/plugins';
import type { UnpluginOptions } from 'unplugin';

import { validateOptions } from '../common/helpers';
import { output } from '../common/output';
import { sendMetrics } from '../common/sender';
import { PLUGIN_NAME } from '../constants';
import type { Compilation, Report, Stats, OptionsWithTelemetry, BundlerContext } from '../types';

import { Loaders } from './loaders';
import { Modules } from './modules';
import { Tapables } from './tapables';

export const getWebpackPlugin = (
    opt: OptionsWithTelemetry,
    ctx: GlobalContext,
): UnpluginOptions['webpack'] => {
    return async (compiler) => {
        const HOOK_OPTIONS = { name: PLUGIN_NAME };
        const options = validateOptions(opt);
        const logger = getLogger(opt.logLevel, 'telemetry');

        const modules = new Modules(ctx.cwd, options);
        const tapables = new Tapables(ctx.cwd, options);
        const loaders = new Loaders(ctx.cwd, options);

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

        // @ts-expect-error - webpack 4 and 5 nonsense.
        compiler.hooks.done.tapPromise(HOOK_OPTIONS, async (stats: Stats) => {
            const start = Date.now();
            const { timings: tapableTimings } = tapables.getResults();
            const { loaders: loadersTimings, modules: modulesTimings } = loaders.getResults();
            const { modules: modulesDeps } = modules.getResults();

            const report: Report = {
                timings: {
                    tapables: tapableTimings,
                    loaders: loadersTimings,
                    modules: modulesTimings,
                },
                dependencies: modulesDeps,
            };

            const context: BundlerContext = {
                start,
                report,
                bundler: { webpack: stats },
            };

            await output(context, options, logger, ctx.cwd);
            await sendMetrics(context.metrics, opt, logger);
        });
    };
};
