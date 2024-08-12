// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getLogger } from '@dd/core/log';
import type { File, GlobalContext, Meta, Options } from '@dd/core/types';
import path from 'path';
import type { UnpluginOptions } from 'unplugin';

// TODO: Add universal config report with list of plugins (names), loaders.
// TODO: Name entries.

const PLUGIN_NAME = 'context-plugin';

const getType = (name: string): string => (name.includes('.') ? name.split('.').pop()! : 'unknown');

const cleanName = (context: GlobalContext, filepath: string) => {
    return filepath
        .replace(context.bundler.outDir, '')
        .replace(context.cwd, '')
        .replace(/^\/+/, '');
};

const rollupPlugin: (context: GlobalContext) => UnpluginOptions['rollup'] = (context) => ({
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
    onLog(level, logItem) {
        if (level === 'warn') {
            context.build.warnings.push(logItem.message || logItem.toString());
        }
    },
    renderError(error) {
        if (error) {
            context.build.errors.push(error.message);
        }
    },
    writeBundle(options, bundle) {
        const inputs: File[] = [];
        const outputs: File[] = [];
        const entries: File[] = [];

        for (const [filename, asset] of Object.entries(bundle)) {
            const filepath = path.join(context.bundler.outDir, filename);
            const size =
                'code' in asset
                    ? Buffer.byteLength(asset.code, 'utf8')
                    : Buffer.byteLength(asset.source, 'utf8');

            const file: File = {
                name: filename,
                filepath,
                size,
                type: getType(filename),
            };

            outputs.push(file);

            if ('modules' in asset) {
                for (const [modulepath, module] of Object.entries(asset.modules)) {
                    const moduleFile: File = {
                        name: cleanName(context, modulepath),
                        filepath: modulepath,
                        // Since we store as entry and inputs, we use the originalLength.
                        size: module.originalLength,
                        type: getType(modulepath),
                    };

                    inputs.push(moduleFile);

                    if ('isEntry' in asset && asset.isEntry) {
                        entries.push(moduleFile);
                    }
                }
            }
        }

        context.build.inputs = inputs;
        context.build.outputs = outputs;
        context.build.entries = entries;
    },
});

export const getGlobalContextPlugins = (opts: Options, meta: Meta) => {
    const log = getLogger(opts.logLevel, PLUGIN_NAME);
    const cwd = process.cwd();
    const variant =
        meta.framework === 'webpack' ? (meta.webpack.compiler['webpack'] ? '5' : '4') : '';
    const globalContext: GlobalContext = {
        auth: opts.auth,
        cwd,
        version: meta.version,
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
    };

    const bundlerSpecificPlugin: UnpluginOptions = {
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
                build.onEnd((result) => {
                    if (!result.metafile) {
                        const warning = 'Missing metafile from build result.';
                        log(warning, 'warn');
                        globalContext.build.warnings.push(warning);
                        return;
                    }

                    // NOTE: We can have more details if needed.
                    globalContext.build.errors = result.errors.map((err) => err.text);
                    globalContext.build.warnings = result.warnings.map((err) => err.text);

                    const inputs: File[] = [];
                    const outputs: File[] = [];
                    const entries: File[] = [];

                    for (const [filename, input] of Object.entries(result.metafile.inputs)) {
                        const file: File = {
                            name: filename,
                            filepath: path.join(cwd, filename),
                            size: input.bytes,
                            type: getType(filename),
                        };

                        inputs.push(file);
                    }

                    for (const [filename, output] of Object.entries(result.metafile.outputs)) {
                        const fullPath = path.join(cwd, filename);
                        const file: File = {
                            name: cleanName(globalContext, fullPath),
                            filepath: fullPath,
                            size: output.bytes,
                            type: getType(fullPath),
                        };

                        outputs.push(file);

                        if (output.entryPoint) {
                            const inputFile = inputs.find(
                                (input) => input.name === output.entryPoint,
                            );

                            if (inputFile) {
                                entries.push(inputFile);
                            }
                        }
                    }

                    globalContext.build.outputs = outputs;
                    globalContext.build.inputs = inputs;
                    globalContext.build.entries = entries;
                });
            },
        },
        webpack(compiler) {
            globalContext.bundler.rawConfig = compiler.options;

            if (compiler.options.output?.path) {
                globalContext.bundler.outDir = compiler.options.output.path;
            }

            compiler.hooks.emit.tap(PLUGIN_NAME, (compilation) => {
                const entries: File[] = [];
                const inputs: File[] = [];
                const outputs: File[] = [];

                globalContext.build.errors = compilation.errors.map((err) => err.message) || [];
                globalContext.build.warnings = compilation.warnings.map((err) => err.message) || [];

                for (const [filename, asset] of Object.entries(compilation.assets)) {
                    const file: File = {
                        size: asset.size(),
                        name: filename,
                        filepath: path.join(globalContext.bundler.outDir, filename),
                        type: getType(filename),
                    };

                    outputs.push(file);
                }

                for (const module of compilation.modules) {
                    // Not interested in the runtime modules.
                    if (module.type === 'runtime') {
                        continue;
                    }

                    const modulePath = module.identifier();

                    const file = {
                        size: module.size(),
                        name: cleanName(globalContext, modulePath),
                        filepath: modulePath,
                        type: getType(modulePath),
                    };

                    inputs.push(file);

                    if (module.isEntryModule()) {
                        entries.push(file);
                    }
                }

                globalContext.build.inputs = inputs;
                globalContext.build.outputs = outputs;
                globalContext.build.entries = entries;
            });
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

    return { globalContext, globalContextPlugins: [bundlerSpecificPlugin] };
};
