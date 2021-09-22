/* eslint-disable no-console */

import { PluginBuild, BuildResult } from 'esbuild';

import { wrapPlugins, getResults as getPluginsResults } from './plugins';
import { BaseClass } from '../BaseClass';
import { Options } from '../types';
import { getModulesResults } from './modules';

class BuildPluginClass extends BaseClass {
    constructor(opts: Options) {
        super(opts);
        // This options is filled by webpack in the webpack plugin.
        this.options.context = process.cwd();
    }
    setup(build: PluginBuild) {
        const startBuild = Date.now();
        // We force esbuild to produce its metafile.
        build.initialOptions.metafile = true;
        wrapPlugins(this, build, build.initialOptions.plugins);
        build.onEnd(async (result: BuildResult) => {
            const { plugins, modules } = getPluginsResults();
            const moduleResults = getModulesResults(result.metafile, this.options.context);

            this.addContext({
                start: startBuild,
                report: {
                    timings: {
                        tapables: plugins,
                        modules,
                    },
                    dependencies: moduleResults,
                },
                result,
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
