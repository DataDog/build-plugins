// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, Options, PluginOptions } from '@dd/core/types';
import path from 'path';

const PLUGIN_NAME = 'datadog-bundler-report-plugin';

const rollupPlugin: (context: GlobalContext) => PluginOptions['rollup'] = (context) => ({
    options(options) {
        context.bundler.rawConfig = options;
        const outputOptions = (options as any).output;
        if (outputOptions) {
            context.bundler.outDir = outputOptions.dir;
        }
    },
    outputOptions(options) {
        if (options.dir) {
            context.bundler.outDir = options.dir;
        }
    },
});

// TODO: Add universal config report with list of plugins (names), loaders.
export const getBundlerReportPlugin = (opts: Options, globalContext: GlobalContext) => {
    const bundlerReportPlugin: PluginOptions = {
        name: PLUGIN_NAME,
        enforce: 'pre',
        esbuild: {
            setup(build) {
                globalContext.bundler.rawConfig = build.initialOptions;

                if (build.initialOptions.outdir) {
                    globalContext.bundler.outDir = build.initialOptions.outdir;
                }

                if (build.initialOptions.outfile) {
                    globalContext.bundler.outDir = path.dirname(build.initialOptions.outfile);
                }

                // We force esbuild to produce its metafile.
                build.initialOptions.metafile = true;
            },
        },
        webpack(compiler) {
            globalContext.bundler.rawConfig = compiler.options;

            if (compiler.options.output?.path) {
                globalContext.bundler.outDir = compiler.options.output.path;
            }
        },
        // Vite and Rollup have the same API.
        vite: rollupPlugin(globalContext),
        rollup: rollupPlugin(globalContext),
    };

    return bundlerReportPlugin;
};
