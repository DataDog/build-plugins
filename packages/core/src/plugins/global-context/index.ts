// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getLogger } from '@dd/core/log';
import type { File, GlobalContext, Meta, Options } from '@dd/core/types';
import path from 'path';
import type { UnpluginOptions } from 'unplugin';

const SPECIFIC_PLUGIN_NAME = 'specific-context-plugin';
const UNIVERSAL_PLUGIN_NAME = 'universal-context-plugin';

export const getGlobalContextPlugins = (opts: Options, meta: Meta) => {
    const log = getLogger(opts.logLevel, 'context-plugin');
    const cwd = process.cwd();
    const globalContext: GlobalContext = {
        auth: opts.auth,
        cwd,
        version: meta.version,
        outputDir: cwd,
        bundler: {
            name: meta.framework,
        },
    };

    const bundlerSpecificPlugin: UnpluginOptions = {
        name: SPECIFIC_PLUGIN_NAME,
        enforce: 'pre',
        esbuild: {
            setup(build) {
                globalContext.bundler.config = build.initialOptions;

                if (build.initialOptions.outdir) {
                    globalContext.outputDir = build.initialOptions.outdir;
                }

                if (build.initialOptions.outfile) {
                    globalContext.outputDir = path.dirname(build.initialOptions.outfile);
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
                        files.push({ filepath: path.join(cwd, output) });
                    }

                    globalContext.outputFiles = files;
                });
            },
        },
        webpack(compiler) {
            // Add variant info in the context.
            globalContext.bundler.variant = compiler['webpack'] ? '5' : '4';
            globalContext.bundler.config = compiler.options;
            if (compiler.options.output?.path) {
                globalContext.outputDir = compiler.options.output.path;
            }

            compiler.hooks.emit.tap(SPECIFIC_PLUGIN_NAME, (compilation) => {
                const files: File[] = [];
                for (const filename of Object.keys(compilation.assets)) {
                    files.push({ filepath: path.join(globalContext.outputDir, filename) });
                }
                globalContext.outputFiles = files;
            });
        },
        vite: {
            options(options) {
                globalContext.bundler.config = options;
                const outputOptions = (options as any).output;
                if (outputOptions) {
                    globalContext.outputDir = outputOptions.dir;
                }
            },
            outputOptions(options) {
                if (options.dir) {
                    globalContext.outputDir = options.dir;
                }
            },
            writeBundle(options, bundle) {
                const files: File[] = [];
                for (const filename of Object.keys(bundle)) {
                    files.push({ filepath: path.join(globalContext.outputDir, filename) });
                }
                globalContext.outputFiles = files;
            },
        },
        rollup: {
            options(options) {
                globalContext.bundler.config = options;
                const outputOptions = (options as any).output;
                if (outputOptions) {
                    globalContext.outputDir = outputOptions.dir;
                }
            },
            outputOptions(options) {
                if (options.dir) {
                    globalContext.outputDir = options.dir;
                }
            },
            writeBundle(options, bundle) {
                const files: File[] = [];
                for (const filename of Object.keys(bundle)) {
                    files.push({ filepath: path.join(globalContext.outputDir, filename) });
                }
                globalContext.outputFiles = files;
            },
        },
        // TODO: Add support and add outputFiles to the context.
        rspack(compiler) {
            globalContext.bundler.config = compiler.options;
        },
        farm: {
            configResolved(config: any) {
                globalContext.bundler.config = config;
            },
        },
    };

    let realBuildEnd: number = 0;
    const universalPlugin: UnpluginOptions = {
        name: UNIVERSAL_PLUGIN_NAME,
        enforce: 'pre',
        buildStart() {
            globalContext.buildStart = Date.now();
        },
        buildEnd() {
            realBuildEnd = Date.now();
        },
        writeBundle() {
            globalContext.buildEnd = Date.now();
            globalContext.buildDuration = globalContext.buildEnd - globalContext.buildStart!;
            globalContext.writeDuration = globalContext.buildEnd - realBuildEnd;
        },
    };

    return { globalContext, globalContextPlugins: [bundlerSpecificPlugin, universalPlugin] };
};
