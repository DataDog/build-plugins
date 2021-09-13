/* eslint-disable no-console */

import { PluginBuild, BuildResult } from 'esbuild';
import path from 'path';

import { writeFile, formatDuration } from '../helpers';
import { wrapPlugins } from './plugins';
import { performance } from 'perf_hooks';

export const BuildPlugin = ({ output }: { output: string }) => {
    return {
        name: `BuildPlugin`,
        setup(build: PluginBuild) {
            const start = performance.now();
            build.initialOptions.metafile = true;
            wrapPlugins(build, build.initialOptions.plugins);
            build.onEnd((result: BuildResult) => {
                writeFile(path.join(output, './stats.json'), result.metafile);
                process.nextTick(() => {
                    console.log(
                        `[BuildPlugin] Build took ${formatDuration(performance.now() - start)}`
                    );
                });
            });
        },
    };
};
