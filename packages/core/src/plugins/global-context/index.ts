// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, Meta, Options, PluginOptions } from '@dd/core/types';
import path from 'path';

// TODO: Add universal config report with list of plugins (names), loaders.

const PLUGIN_NAME = 'datadog-context-plugin';

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

export const getGlobalContextPlugin = (opts: Options, meta: Meta) => {
    const cwd = process.cwd();
    const variant =
        meta.framework === 'webpack' ? (meta.webpack.compiler['webpack'] ? '5' : '4') : '';

    const globalContext: GlobalContext = {
        auth: opts.auth,
        bundler: {
            name: meta.framework,
            fullName: `${meta.framework}${variant}`,
            variant,
            outDir: cwd,
        },
        build: {
            errors: [],
            warnings: [],
        },
        cwd,
        start: Date.now(),
        version: meta.version,
    };

    const globalContextPlugin: PluginOptions = {
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
        // TODO: Add support and add outputFiles to the context.
        rspack(compiler) {
            globalContext.bundler.rawConfig = compiler.options;
        },
        farm: {
            configResolved(config: any) {
                globalContext.bundler.rawConfig = config;
            },
        },
    };

    return { globalContext, globalContextPlugin };
};
