// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getLogger } from '@dd/core/log';
import type { Entry, File, GlobalContext, Meta, Options, Output } from '@dd/core/types';
import { writeFileSync } from 'fs';
import path from 'path';
import type { UnpluginOptions } from 'unplugin';

// TODO: Add universal config report with list of plugins (names), loaders.

const PLUGIN_NAME = 'context-plugin';

const getType = (name: string): string => {
    if (name === 'unknown') {
        return name;
    }

    if (name.includes('webpack/runtime')) {
        return 'runtime';
    }

    return name.includes('.') ? name.split('.').pop()! : 'unknown';
};

const cleanName = (context: GlobalContext, filepath: string) => {
    if (filepath === 'unknown') {
        return filepath;
    }

    if (filepath.includes('webpack/runtime')) {
        return filepath.replace('webpack/runtime/', '').replace(/ +/g, '-');
    }

    let resolvedPath = filepath;
    try {
        resolvedPath = require.resolve(filepath);
    } catch (e) {
        // No problem, we keep the initial path.
    }

    return resolvedPath
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
        const outputs: Output[] = [];
        const tempEntryFiles: [Entry, any][] = [];
        const entries: Entry[] = [];

        writeFileSync('output.rollup.json', JSON.stringify(bundle, null, 4));

        // Fill in inputs and outputs.
        for (const [filename, asset] of Object.entries(bundle)) {
            const filepath = path.join(context.bundler.outDir, filename);
            const size =
                'code' in asset
                    ? Buffer.byteLength(asset.code, 'utf8')
                    : Buffer.byteLength(asset.source, 'utf8');

            const file: Output = {
                name: filename,
                filepath,
                inputs: [],
                size,
                type: getType(filename),
            };

            if ('modules' in asset) {
                for (const [modulepath, module] of Object.entries(asset.modules)) {
                    const moduleFile: File = {
                        name: cleanName(context, modulepath),
                        filepath: modulepath,
                        // Since we store as entry and inputs, we use the originalLength.
                        size: module.originalLength,
                        type: getType(modulepath),
                    };

                    file.inputs.push(moduleFile);
                }
            }

            if ('isEntry' in asset && asset.isEntry) {
                tempEntryFiles.push([
                    { ...file, name: asset.name, size: 0, outputs: [file] },
                    asset,
                ]);
            }

            outputs.push(file);
            inputs.push(...file.inputs);
        }

        // Second loop to fill in entries
        for (const [entryFile, asset] of tempEntryFiles) {
            // If it imports other outputs we add them to it.
            for (const outputName of asset.imports) {
                const module = outputs.find((output) => output.name === outputName);
                if (module) {
                    entryFile.outputs.push(module);
                    entryFile.inputs.push(...module.inputs);
                    entryFile.size += module.size;
                }
            }

            entries.push(entryFile);
        }

        context.build.inputs = inputs;
        context.build.outputs = outputs;
        context.build.entries = entries;
        writeFileSync('report.rollup.json', JSON.stringify(context.build, null, 4));
    },
});

export const getGlobalContextPlugins = (opts: Options, meta: Meta) => {
    const log = getLogger(opts.logLevel, PLUGIN_NAME);
    const cwd = process.cwd();
    const variant =
        meta.framework === 'webpack' ? (meta.webpack.compiler['webpack'] ? '5' : '4') : '';
    const globalContext: GlobalContext = {
        auth: opts.auth,
        start: Date.now(),
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

                // Store entry names based on the configuration.
                const entrypoints = build.initialOptions.entryPoints;
                const entryNames = new Map();
                if (Array.isArray(entrypoints)) {
                    // We don't have an indexed object as entry, so we can't get an entry name from it.
                    for (const entry of entrypoints) {
                        const fullPath = entry && typeof entry === 'object' ? entry.in : entry;
                        const realEntry = cleanName(globalContext, fullPath);
                        entryNames.set(realEntry, realEntry);
                    }
                } else if (entrypoints) {
                    const entryList = entrypoints ? Object.entries(entrypoints) : [];
                    for (const [entryName, entryPath] of entryList) {
                        entryNames.set(cleanName(globalContext, entryPath), entryName);
                    }
                }

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
                    const outputs: Output[] = [];
                    const tempEntryFiles: [Entry, any][] = [];
                    const entries: Entry[] = [];

                    // Loop through inputs.
                    for (const [filename, input] of Object.entries(result.metafile.inputs)) {
                        const file: File = {
                            name: filename,
                            filepath: path.join(cwd, filename),
                            size: input.bytes,
                            type: getType(filename),
                        };

                        inputs.push(file);
                    }

                    // Loop through outputs.
                    for (const [filename, output] of Object.entries(result.metafile.outputs)) {
                        const fullPath = path.join(cwd, filename);
                        // Get inputs of this output.
                        const inputFiles = [];
                        for (const inputName of Object.keys(output.inputs)) {
                            const inputFound = inputs.find((input) => input.name === inputName);
                            if (!inputFound) {
                                continue;
                            }

                            inputFiles.push(inputFound);
                        }

                        const file: Output = {
                            name: cleanName(globalContext, fullPath),
                            filepath: fullPath,
                            inputs: inputFiles,
                            size: output.bytes,
                            type: getType(fullPath),
                        };

                        outputs.push(file);

                        if (!output.entryPoint) {
                            continue;
                        }

                        const inputFile = inputs.find((input) => input.name === output.entryPoint);

                        if (inputFile) {
                            const entry = {
                                ...file,
                                name: entryNames.get(inputFile.name) || inputFile.name,
                                // Compute this
                                outputs: [file],
                                // Compute this
                                size: file.size,
                            };

                            tempEntryFiles.push([entry, output]);
                        }
                    }

                    // Loop through entries.
                    for (const [entryFile, asset] of tempEntryFiles) {
                        // If it imports other outputs we add them to it.
                        for (const importedAsset of asset.imports) {
                            const module = outputs.find(
                                (output) => output.name === importedAsset.path,
                            );

                            if (module) {
                                entryFile.outputs.push(module);
                                entryFile.inputs.push(...module.inputs);
                                entryFile.size += module.size;
                            }
                        }

                        entries.push(entryFile);
                    }

                    globalContext.build.outputs = outputs;
                    globalContext.build.inputs = inputs;
                    globalContext.build.entries = entries;

                    writeFileSync(
                        'report.esbuild.json',
                        JSON.stringify(globalContext.build, null, 4),
                    );
                    writeFileSync('output.esbuild.json', JSON.stringify(result, null, 4));
                });
            },
        },
        webpack(compiler) {
            globalContext.bundler.rawConfig = compiler.options;

            if (compiler.options.output?.path) {
                globalContext.bundler.outDir = compiler.options.output.path;
            }

            compiler.hooks.afterEmit.tap(PLUGIN_NAME, (compilation) => {
                const inputs: File[] = [];
                const outputs: Output[] = [];
                const entries: Entry[] = [];

                globalContext.build.errors = compilation.errors.map((err) => err.message) || [];
                globalContext.build.warnings = compilation.warnings.map((err) => err.message) || [];

                const stats = compilation.getStats().toJson({
                    all: false,
                    assets: true,
                    children: true,
                    chunks: true,
                    chunkGroupAuxiliary: true,
                    chunkGroupChildren: true,
                    chunkGroups: true,
                    chunkModules: true,
                    entrypoints: true,
                    errors: true,
                    ids: true,
                    modules: true,
                    relatedAssets: true,
                    runtime: true,
                    runtimeModules: true,
                    warnings: true,
                });

                const chunks = stats.chunks || [];
                const assets = stats.assets || [];
                const modules = stats.modules || [];
                const entrypoints = stats.entrypoints || [];

                // Build outputs
                for (const asset of assets) {
                    const file: Output = {
                        size: asset.size,
                        name: asset.name,
                        // Fill this one up.
                        inputs: [],
                        filepath: path.join(globalContext.bundler.outDir, asset.name),
                        type: getType(asset.name),
                    };
                    outputs.push(file);

                    // In webpack 5, sourcemaps are only stored in asset.related.
                    // In webpack 4, sourcemaps are top-level assets.
                    if (asset.related) {
                        for (const related of asset.related) {
                            const relatedFile: Output = {
                                size: related.size,
                                name: related.name,
                                inputs: [],
                                filepath: path.join(globalContext.bundler.outDir, related.name),
                                type: getType(related.name),
                            };
                            outputs.push(relatedFile);
                        }
                    }
                }

                // Build inputs
                for (const module of modules) {
                    const modulePath = module.identifier
                        ? module.identifier
                        : module.name
                          ? path.join(globalContext.cwd, module.name)
                          : 'unknown';

                    if (modulePath === 'unknown') {
                        log(`Unknown module: ${JSON.stringify(module)}`, 'warn');
                    }

                    const file: File = {
                        size: module.size || 0,
                        name: cleanName(globalContext, modulePath),
                        filepath: modulePath,
                        type: getType(modulePath),
                    };

                    // Assign the file to their related output's inputs.
                    for (const chunkId of module.chunks || []) {
                        const chunkFound = chunks.find((chunk) => chunk.id === chunkId);
                        if (!chunkFound) {
                            continue;
                        }

                        const chunkFiles = chunkFound.files || [];
                        if (chunkFound.auxiliaryFiles) {
                            chunkFiles.push(...chunkFound.auxiliaryFiles);
                        }

                        const outputsFound = outputs.filter(
                            (output) =>
                                chunkFiles.includes(output.name) ||
                                chunkFiles.includes(`${output.name}.map`),
                        );
                        if (!outputsFound.length) {
                            continue;
                        }

                        for (const outputFound of outputsFound) {
                            outputFound.inputs.push(file);
                        }
                    }

                    inputs.push(file);
                }

                // Build entries
                for (const [name, entry] of Object.entries(entrypoints)) {
                    const entryOutputs: Output[] = [];
                    const entryInputs: File[] = [];
                    let size = 0;
                    // Include sourcemaps in the entry assets.
                    const entryAssets = entry.assets || [];
                    if (entry.auxiliaryAssets) {
                        entryAssets.push(...entry.auxiliaryAssets);
                    }

                    for (const asset of entryAssets) {
                        let outputFound;
                        // Webpack 5 is a list of objects.
                        // Webpack 4 is a list of strings.
                        if (typeof asset === 'string') {
                            outputFound = outputs.find((output) => output.name === asset);
                        } else {
                            outputFound = outputs.find((output) => output.name === asset.name);
                        }

                        if (outputFound) {
                            entryOutputs.push(outputFound);
                            entryInputs.push(...outputFound.inputs);
                            // We don't want to include sourcemaps in the sizing.
                            if (outputFound.type !== 'map') {
                                size += outputFound.size;
                            }
                        }
                    }

                    const assetFound = assets.find((asset) => asset.chunkNames?.includes(name));
                    const file: Entry = {
                        name,
                        filepath: assetFound
                            ? path.join(globalContext.bundler.outDir, assetFound.name)
                            : 'unknown',
                        size,
                        inputs: entryInputs,
                        outputs: entryOutputs,
                        type: assetFound ? getType(assetFound.name) : 'unknown',
                    };
                    entries.push(file);
                }

                globalContext.build.inputs = inputs;
                globalContext.build.outputs = outputs;
                globalContext.build.entries = entries;

                writeFileSync(
                    `report.${globalContext.bundler.fullName}.json`,
                    JSON.stringify(globalContext.build, null, 4),
                );
                writeFileSync(
                    `output.${globalContext.bundler.fullName}.json`,
                    JSON.stringify(stats, null, 4),
                );

                console.log('END CONTEXT', globalContext.bundler.fullName);
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
