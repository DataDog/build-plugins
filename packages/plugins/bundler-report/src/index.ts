// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    getAbsolutePath,
    getNearestCommonDirectory,
    getHighestPackageJsonDir,
} from '@dd/core/helpers';
import type { GlobalContext, PluginOptions } from '@dd/core/types';
import path from 'path';

export const PLUGIN_NAME = 'datadog-bundler-report-plugin';

// Compute the CWD based on a list of directories and the outDir.
const getCwd = (dirs: Set<string>, outDir: string) => {
    const highestPackage = getHighestPackageJsonDir(outDir);
    if (highestPackage) {
        return highestPackage;
    }

    // Fall back to the nearest common directory.
    const nearestDir = getNearestCommonDirectory(Array.from(dirs));
    if (nearestDir !== path.sep) {
        return nearestDir;
    }
};

const xpackPlugin: (context: GlobalContext) => PluginOptions['webpack'] & PluginOptions['rspack'] =
    (context) => (compiler) => {
        context.bundler.rawConfig = compiler.options;

        if (compiler.options.output?.path) {
            context.bundler.outDir = compiler.options.output.path;
        }
        context.hook('bundlerReport', context.bundler);

        if (compiler.options.context) {
            context.cwd = compiler.options.context;
        }
        context.hook('cwd', context.cwd);
    };

// TODO: Add universal config report with list of plugins (names), loaders.
export const getBundlerReportPlugins = (context: GlobalContext): PluginOptions[] => {
    const directories: Set<string> = new Set();
    const handleOutputOptions = (outputOptions: any) => {
        if (!outputOptions) {
            return;
        }

        if (outputOptions.dir) {
            context.bundler.outDir = outputOptions.dir;
            directories.add(outputOptions.dir);
        } else if (outputOptions.file) {
            context.bundler.outDir = path.dirname(outputOptions.file);
            directories.add(context.bundler.outDir);
        }

        // We need an absolute path for rollup because of the way we have to compute its CWD.
        // It's relative to process.cwd(), because there is no cwd options for rollup.
        context.bundler.outDir = getAbsolutePath(process.cwd(), context.bundler.outDir);

        context.hook('bundlerReport', context.bundler);

        // Vite has the "root" option we're using.
        if (context.bundler.name === 'vite') {
            return;
        }

        context.cwd = getCwd(directories, context.bundler.outDir) || context.cwd;
        context.hook('cwd', context.cwd);
    };

    const rollupPlugin: () => PluginOptions['rollup'] & PluginOptions['vite'] = () => {
        return {
            options(options) {
                context.bundler.rawConfig = options;
                if (options.input) {
                    if (Array.isArray(options.input)) {
                        for (const input of options.input) {
                            directories.add(path.dirname(input));
                        }
                    } else if (typeof options.input === 'object') {
                        for (const input of Object.values(options.input)) {
                            directories.add(path.dirname(input));
                        }
                    } else if (typeof options.input === 'string') {
                        directories.add(path.dirname(options.input));
                    } else {
                        throw new Error('Invalid input type');
                    }
                }

                if ('output' in options) {
                    const outputOptions = Array.isArray(options.output)
                        ? options.output
                        : [options.output];
                    for (const output of outputOptions) {
                        handleOutputOptions(output);
                    }
                }
            },
        };
    };

    const bundlerReportPlugin: PluginOptions = {
        name: PLUGIN_NAME,
        enforce: 'pre',
        esbuild: {
            setup(build) {
                context.bundler.rawConfig = build.initialOptions;

                if (build.initialOptions.outdir) {
                    context.bundler.outDir = build.initialOptions.outdir;
                }

                if (build.initialOptions.outfile) {
                    context.bundler.outDir = path.dirname(build.initialOptions.outfile);
                }
                context.hook('bundlerReport', context.bundler);

                if (build.initialOptions.absWorkingDir) {
                    context.cwd = build.initialOptions.absWorkingDir;
                }
                context.hook('cwd', context.cwd);

                // We force esbuild to produce its metafile.
                build.initialOptions.metafile = true;
            },
        },
        webpack: xpackPlugin(context),
        rspack: xpackPlugin(context),
        // Vite and Rollup have (almost) the same API.
        // They don't really support the CWD concept,
        // so we have to compute it based on existing configurations.
        // The basic idea is to compare input vs output and keep the common part of the paths.
        vite: {
            ...rollupPlugin(),
            config(config) {
                if (config.root) {
                    context.cwd = config.root;
                } else {
                    context.cwd = getCwd(directories, context.bundler.outDir) || context.cwd;
                }
                context.hook('cwd', context.cwd);
            },
        },
        rollup: rollupPlugin(),
    };

    return [bundlerReportPlugin];
};
