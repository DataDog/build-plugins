// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, PluginOptions } from '@dd/core/types';
import path from 'path';

export const PLUGIN_NAME = 'datadog-bundler-report-plugin';

// From a list of path, return the nearest common directory.
const getNearestCommonDirectory = (dirs: string[], cwd: string) => {
    const splitPaths = dirs.map((dir) => {
        const absolutePath = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
        return absolutePath.split(path.sep);
    });

    // Use the shortest length for faster results.
    const minLength = Math.min(...splitPaths.map((parts) => parts.length));
    const commonParts = [];

    for (let i = 0; i < minLength; i++) {
        // We use the first path as our basis.
        const component = splitPaths[0][i];
        if (splitPaths.every((parts) => parts[i] === component)) {
            commonParts.push(component);
        } else {
            break;
        }
    }

    return commonParts.length > 0 ? commonParts.join(path.sep) : path.sep;
};

const handleCwd = (dirs: string[], context: GlobalContext) => {
    const nearestDir = getNearestCommonDirectory(dirs, context.cwd);
    if (nearestDir !== path.sep) {
        context.cwd = nearestDir;
    }
};

const xpackPlugin: (context: GlobalContext) => PluginOptions['webpack'] & PluginOptions['rspack'] =
    (context) => (compiler) => {
        context.bundler.rawConfig = compiler.options;

        if (compiler.options.output?.path) {
            context.bundler.outDir = compiler.options.output.path;
        }

        if (compiler.options.context) {
            context.cwd = compiler.options.context;
        }
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
            directories.add(outputOptions.dir);
        }

        // Vite has the "root" option we're using.
        if (context.bundler.name === 'vite') {
            return;
        }

        handleCwd(Array.from(directories), context);
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
                    handleOutputOptions(options.output);
                }
            },
            outputOptions(options) {
                handleOutputOptions(options);
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

                if (build.initialOptions.absWorkingDir) {
                    context.cwd = build.initialOptions.absWorkingDir;
                }

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
            config(config) {
                if (config.root) {
                    context.cwd = config.root;
                } else {
                    handleCwd(Array.from(directories), context);
                }
            },
            ...rollupPlugin(),
        },
        rollup: rollupPlugin(),
    };

    return [bundlerReportPlugin];
};
