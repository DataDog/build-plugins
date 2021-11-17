// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-console */

import { PluginBuild, BuildResult } from 'esbuild';

import { wrapPlugins, getResults as getPluginsResults } from './plugins';
import { BaseClass } from '../BaseClass';
import { Options } from '../types';
import { getModulesResults } from './modules';

class BuildPluginClass extends BaseClass {
    constructor(opts: Options) {
        super(opts);
        this.options.context = opts.context || process.cwd();
    }
    setup(build: PluginBuild) {
        const startBuild = Date.now();
        // We force esbuild to produce its metafile.
        build.initialOptions.metafile = true;
        wrapPlugins(this, build, build.initialOptions.plugins);
        build.onEnd(async (result: BuildResult) => {
            const { plugins, modules } = getPluginsResults();
            // We know it exists since we're setting the option earlier.
            const metaFile = result.metafile!;
            const moduleResults = getModulesResults(metaFile, this.options.context);

            this.addContext({
                start: startBuild,
                report: {
                    timings: {
                        tapables: plugins,
                        modules,
                    },
                    dependencies: moduleResults,
                },
                bundler: {
                    esbuild: {
                        warnings: result.warnings,
                        errors: result.errors,
                        entrypoints: build.initialOptions.entryPoints,
                        duration: Date.now() - startBuild,
                        ...metaFile,
                    },
                },
            });

            await this.applyHooks('output');
            this.log('Work done.');
        });
    }
}

export const BuildPlugin = (opts: Options) => {
    const plugin = new BuildPluginClass(opts);

    return {
        name: 'BuildPlugin',
        setup: plugin.setup.bind(plugin),
    };
};
