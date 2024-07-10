// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getLogger } from '@dd/core/log';
import type { File, GlobalContext, Meta, Options } from '@dd/core/types';
import path from 'path';
import type { UnpluginOptions } from 'unplugin';

const PLUGIN_NAME = 'global-context-plugin';

export const getGlobalContextPlugin = (opts: Options, meta: Meta) => {
    const log = getLogger(opts.logLevel, 'internal-global-context');
    const globalContext: GlobalContext = {
        auth: opts.auth,
        cwd: process.cwd(),
        version: meta.version,
        outputDir: process.cwd(),
        bundler: {
            name: meta.framework,
        },
    };

    const globalContextPlugin: UnpluginOptions = {
        name: PLUGIN_NAME,
        enforce: 'pre',
        esbuild: {
            setup(build) {
                globalContext.bundler.config = build.initialOptions;
                if (build.initialOptions.outdir) {
                    globalContext.outputDir = build.initialOptions.outdir;
                }
                // We force esbuild to produce its metafile.
                build.initialOptions.metafile = true;
                build.onEnd((result) => {
                    if (!result.metafile) {
                        log('Missing metafile from build result.', 'warn');
                        return;
                    }

                    const files: File[] = [];
                    for (const [output] of Object.entries(result.metafile.outputs)) {
                        files.push({ filepath: path.join(globalContext.outputDir, output) });
                    }

                    globalContext.outputFiles = files;
                });
            },
        },
        webpack(compiler) {
            globalContext.bundler.config = compiler.options;
            if (compiler.options.output?.path) {
                globalContext.outputDir = compiler.options.output.path;
            }

            compiler.hooks.done.tap(PLUGIN_NAME, (stats) => {
                const statsJson = stats.toJson();
                const { outputPath = '', entrypoints } = statsJson;
                const files: File[] = [];

                globalContext.outputDir = outputPath;

                if (!entrypoints) {
                    log('Missing entrypoints in stats.', 'warn');
                    return;
                }

                const getFile = (asset: { name: string } | string) => {
                    if (typeof asset === 'string') {
                        return {
                            filepath: path.join(outputPath, asset),
                        };
                    } else {
                        return {
                            filepath: path.join(outputPath, asset.name),
                        };
                    }
                };

                for (const [, entry] of Object.entries(entrypoints)) {
                    if (!entry) {
                        continue;
                    }

                    if (entry.assets) {
                        files.push(...entry.assets.map(getFile));
                    }
                    if (entry.auxiliaryAssets) {
                        files.push(...entry.auxiliaryAssets.map(getFile));
                    }
                }
                globalContext.outputFiles = files;
            });
        },
        vite: {
            options(options: any) {
                globalContext.bundler.config = options;
            },
        },
        rollup: {
            options(options: any) {
                globalContext.bundler.config = options;
            },
        },
        rspack(compiler) {
            globalContext.bundler.config = compiler.options;
        },
        farm: {
            configResolved(config: any) {
                globalContext.bundler.config = config;
            },
        },
    };

    return { globalContext, globalContextPlugin };
};
