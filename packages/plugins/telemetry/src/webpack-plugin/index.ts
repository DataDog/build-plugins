import type { Compilation, Report, Stats } from '@datadog/build-plugins-core/types';
import type { UnpluginOptions } from 'unplugin';

import { output } from '../common/output';
import { CONFIG_KEY, PLUGIN_NAME } from '../constants';
import type { Context, OptionsWithTelemetryEnabled } from '../types';

import { Loaders } from './loaders';
import { Modules } from './modules';
import { Tapables } from './tapables';

export const getWebpackPlugin = (opt: OptionsWithTelemetryEnabled): UnpluginOptions['webpack'] => {
    return async (compiler) => {
        const HOOK_OPTIONS = { name: PLUGIN_NAME };
        const options = opt[CONFIG_KEY];

        const modules = new Modules(opt.cwd, options);
        const tapables = new Tapables(opt.cwd, options);
        const loaders = new Loaders(opt.cwd, options);

        tapables.throughHooks(compiler);

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

            const context: Context = {
                start,
                report,
                bundler: { webpack: stats },
            };

            await output(context, opt);
        });
    };
};