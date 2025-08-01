// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getAbsolutePath, getNearestCommonDirectory } from '@dd/core/helpers/paths';
import type {
    GetInternalPlugins,
    GetPluginsArg,
    GlobalContext,
    PluginOptions,
} from '@dd/core/types';
import path from 'path';
import type { OutputOptions } from 'rollup';

export const PLUGIN_NAME = 'datadog-bundler-report-plugin';

export const getAbsoluteOutDir = (cwd: string, outDir?: string) => {
    if (!outDir) {
        return '';
    }

    return path.isAbsolute(outDir) ? outDir : path.resolve(cwd, outDir);
};

export const getOutDirsFromOutputs = (
    outputOptions?: OutputOptions | OutputOptions[],
): string[] => {
    if (!outputOptions) {
        return [];
    }

    const normalizedOutput = Array.isArray(outputOptions) ? outputOptions : [outputOptions];
    return normalizedOutput
        .map((o) => {
            if (o.dir) {
                return o.dir;
            }
            if (o.file) {
                return path.dirname(o.file);
            }
        })
        .filter(Boolean) as string[];
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
    return {
        configResolved(config) {
            context.bundler.rawConfig = config;
            // If we have the outDir configuration from Vite.
            let outDir = config.build?.outDir ?? 'dist';
            // We need to know if we have a rollup output configuration.
            // As it will override Vite's outDir and root.
            const output = config.build?.rollupOptions?.output as
                | OutputOptions
                | OutputOptions[]
                | undefined;

            const outDirs = getOutDirsFromOutputs(output);

            // Vite will fallback to process.cwd() if no root is provided.
            context.cwd = config.root ?? process.cwd();
            // Vite will fallback to process.cwd() if we have an output configuration with dirs.
            if (output && outDirs.length) {
                // Now compute the nearest common directory from the output directories.
                outDir = getNearestCommonDirectory(outDirs, process.cwd());
            }

            // Make sure the outDir is absolute.
            context.bundler.outDir = getAbsoluteOutDir(context.cwd, outDir);

            context.hook('cwd', context.cwd);
            context.hook('bundlerReport', context.bundler);
        },
    };
};

// TODO: Add universal config report with list of plugins (names), loaders.
export const getBundlerReportPlugins: GetInternalPlugins = (arg: GetPluginsArg) => {
    const { context } = arg;
    const log = context.getLogger(PLUGIN_NAME);

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
            options(options) {
                // By default, with relative paths, rollup will use process.cwd() as the CWD.
                let outDir;
                if ('output' in options) {
                    const outDirs = getOutDirsFromOutputs(
                        options.output as OutputOptions | OutputOptions[],
                    );
                    outDir = getNearestCommonDirectory(outDirs, process.cwd());
                }

                if (outDir) {
                    context.bundler.outDir = getAbsolutePath(process.cwd(), outDir);
                    context.cwd = context.bundler.outDir;
                } else {
                    // Fallback to process.cwd()/dist as it is rollup's default.
                    context.cwd = process.cwd();
                    context.bundler.outDir = path.resolve(process.cwd(), 'dist');
                }

                context.hook('cwd', context.cwd);
            },
            buildStart(options) {
                // Save the resolved options.
                context.bundler.rawConfig = options;
            },
            renderStart(outputOptions) {
                // Save the resolved options.
                context.bundler.rawConfig.outputs = context.bundler.rawConfig.outputs || [];
                context.bundler.rawConfig.outputs.push(outputOptions);
                context.hook('bundlerReport', context.bundler);

                // Verify that the output directory is the same as the one computed in the options hook.
                const outDirs = getOutDirsFromOutputs(outputOptions);
                // Rollup always uses process.cwd() as the CWD.
                const outDir = getNearestCommonDirectory(outDirs, process.cwd());
                if (!outDir.startsWith(context.bundler.outDir)) {
                    log.info(
                        'The output directory has been changed by a plugin and may introduce some inconsistencies in the build report.',
                    );
                }
            },
        },
    };

    return [bundlerReportPlugin];
};
