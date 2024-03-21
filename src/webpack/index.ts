// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-console */

import { BaseClass } from '@datadog/build-plugins-core/BaseClass';
import { Loaders } from './loaders';
import { Modules } from './modules';
import { Tapables } from './tapables';
import { Compilation, Report, Compiler, Stats } from '@datadog/build-plugins-core/types';

export class BuildPlugin extends BaseClass {
    apply(compiler: Compiler) {
        if (this.options.disabled) {
            return;
        }

        const PLUGIN_NAME = this.name;
        const HOOK_OPTIONS = { name: PLUGIN_NAME };

        const modules = new Modules(this.options);
        const tapables = new Tapables(this.options);
        const loaders = new Loaders(this.options);

        tapables.throughHooks(compiler);

        compiler.hooks.thisCompilation.tap(HOOK_OPTIONS, (compilation: Compilation) => {
            this.options.context = this.options.context || compilation.options.context;
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

            this.addContext({
                start,
                report,
                bundler: { webpack: stats },
            });

            await this.applyHooks('output');
            this.log('Work done.');
        });
    }
}
