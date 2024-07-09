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
                // We force esbuild to produce its metafile.
                build.initialOptions.metafile = true;
                build.onEnd((result) => {
                    if (!result.metafile) {
                        log('Missing metafile from build result.', 'warn');
                        return;
                    }

                    const files: File[] = [];
                    for (const [output] of Object.entries(result.metafile.outputs)) {
                        files.push({ filepath: path.join(globalContext.cwd, output) });
                    }

                    globalContext.outputFiles = files;
                });
            },
        },
        webpack(compiler) {
            globalContext.bundler.config = compiler.options;
            compiler.hooks.done.tap(PLUGIN_NAME, (stats) => {
                const statsJson = stats.toJson();
                // TODO: outputPath should fallback to what's been aggregated from the config.
                const { outputPath = '', entrypoints } = statsJson;
                const files: File[] = [];

                if (!entrypoints) {
                    log('Missing entrypoints in stats.', 'warn');
                    return;
                }

                for (const [, entry] of Object.entries(entrypoints)) {
                    if (!entry) {
                        continue;
                    }

                    if (entry.assets) {
                        files.push(
                            ...entry.assets.map((asset) => ({
                                filepath: path.join(outputPath, asset.name),
                            })),
                        );
                    }
                    if (entry.auxiliaryAssets) {
                        files.push(
                            ...entry.auxiliaryAssets.map((asset) => ({
                                filepath: path.join(outputPath, asset.name),
                            })),
                        );
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
