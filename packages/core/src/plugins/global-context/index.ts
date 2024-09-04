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
    const cwd = process.cwd();
    const globalContext: GlobalContext = {
        auth: opts.auth,
        start: Date.now(),
        cwd,
        version: meta.version,
        outputDir: cwd,
        bundler: {
            name: meta.framework,
        },
        build: {
            errors: [],
            warnings: [],
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

                if (build.initialOptions.outfile) {
                    globalContext.outputDir = path.dirname(build.initialOptions.outfile);
                }

                // We force esbuild to produce its metafile.
                build.initialOptions.metafile = true;
            },
        },
        webpack(compiler) {
            globalContext.bundler.config = compiler.options;
            if (compiler.options.output?.path) {
                globalContext.outputDir = compiler.options.output.path;
            }
        },
        vite: {
            options(options) {
                globalContext.bundler.config = options;
            },
            outputOptions(options) {
                if (options.dir) {
                    globalContext.outputDir = options.dir;
                }
            },
        },
        rollup: {
            options(options) {
                globalContext.bundler.config = options;
            },
            outputOptions(options) {
                if (options.dir) {
                    globalContext.outputDir = options.dir;
                }
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
