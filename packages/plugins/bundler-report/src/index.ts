// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    GetInternalPlugins,
    GetPluginsArg,
    GlobalContext,
    PluginOptions,
} from '@dd/core/types';
import path from 'path';
import type { OutputOptions } from 'rollup';

import { computeCwd, getOutDirFromOutputs } from './helpers/rollup';

export const PLUGIN_NAME = 'datadog-bundler-report-plugin';

export const getAbsoluteOutDir = (cwd: string, outDir?: string) => {
    if (!outDir) {
        return '';
    }

    return path.isAbsolute(outDir) ? outDir : path.resolve(cwd, outDir);
};

const xpackPlugin: (context: GlobalContext) => PluginOptions['webpack'] & PluginOptions['rspack'] =
    (context) => (compiler) => {
        context.bundler.rawConfig = compiler.options;

        if (compiler.options.output?.path) {
            // While webpack doesn't allow for non-absolute paths,
            // rspack does, and will fallback to use process.cwd().
            context.bundler.outDir = getAbsoluteOutDir(process.cwd(), compiler.options.output.path);
        }
        context.hook('bundlerReport', context.bundler);

        if (compiler.options.context) {
            context.cwd = compiler.options.context;
        }
        context.hook('cwd', context.cwd);
    };

const vitePlugin = (context: GlobalContext): PluginOptions['vite'] => {
    let gotViteCwd = false;
    return {
        configResolved(config) {
            context.bundler.rawConfig = config;

            let outDir = '';
            // If we have the outDir configuration from Vite.
            if (config.build?.outDir) {
                outDir = config.build.outDir;
            } else {
                outDir = 'dist';
            }

            if (config.root) {
                context.cwd = config.root;
                context.hook('cwd', context.cwd);
                gotViteCwd = true;
            }

            // Make sure the outDir is absolute.
            context.bundler.outDir = getAbsoluteOutDir(context.cwd, outDir);
        },
        renderStart(outputOptions) {
            // If we couldn't set the CWD in the config hook, we fallback here.
            if (!gotViteCwd) {
                // Reset the CWD/outDir from the config hook.
                const relativeOutDir = path.relative(context.cwd, context.bundler.outDir);
                // Vite will fallback to process.cwd() if no root is provided.
                context.cwd = process.cwd();
                context.hook('cwd', context.cwd);

                // Update the bundler's outDir based on the CWD.
                context.bundler.outDir = getAbsoluteOutDir(context.cwd, relativeOutDir);
            }

            // When output is provided, rollup will take over and ignore vite's outDir.
            // And when you use `rollupOptions.output.dir` in Vite,
            // the absolute path for outDir is computed based on the process' CWD.
            const outDir = getOutDirFromOutputs(outputOptions as OutputOptions);
            if (outDir) {
                context.bundler.outDir = getAbsoluteOutDir(process.cwd(), outDir);
            }

            context.hook('bundlerReport', context.bundler);
        },
    };
};

// TODO: Add universal config report with list of plugins (names), loaders.
export const getBundlerReportPlugins: GetInternalPlugins = (arg: GetPluginsArg) => {
    const { context } = arg;

    const bundlerReportPlugin: PluginOptions = {
        name: PLUGIN_NAME,
        enforce: 'pre',
        esbuild: {
            setup(build) {
                context.bundler.rawConfig = build.initialOptions;

                if (build.initialOptions.absWorkingDir) {
                    context.cwd = build.initialOptions.absWorkingDir;
                }

                if (build.initialOptions.outdir) {
                    context.bundler.outDir = getAbsoluteOutDir(
                        context.cwd,
                        build.initialOptions.outdir,
                    );
                }

                if (build.initialOptions.outfile) {
                    context.bundler.outDir = getAbsoluteOutDir(
                        context.cwd,
                        path.dirname(build.initialOptions.outfile),
                    );
                }

                context.hook('cwd', context.cwd);
                context.hook('bundlerReport', context.bundler);

                // We force esbuild to produce its metafile.
                build.initialOptions.metafile = true;
            },
        },
        webpack: xpackPlugin(context),
        rspack: xpackPlugin(context),
        vite: vitePlugin(context),
        rollup: {
            // TODO Once we support multi-output builds, update the "cwd" if configs changed in another plugin.
            // Will need to be done in buildStart and renderStart, where the options are fully resolved.
            options(options) {
                context.bundler.rawConfig = options;
                context.cwd = computeCwd(options);
                context.hook('cwd', context.cwd);
            },
            renderStart(outputOptions) {
                const outDir = getOutDirFromOutputs(outputOptions);
                if (outDir) {
                    context.bundler.outDir = getAbsoluteOutDir(process.cwd(), outDir);
                } else {
                    // Fallback to process.cwd()/dist as it is rollup's default.
                    context.bundler.outDir = path.resolve(process.cwd(), 'dist');
                }

                context.hook('bundlerReport', context.bundler);
            },
        },
    };

    return [bundlerReportPlugin];
};
