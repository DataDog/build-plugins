// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';

import type { Logger } from '../../log';
import type { Entry, GlobalContext, Input, Output, PluginOptions } from '../../types';

import { cleanName, cleanReport, getType } from './helpers';

export const getWebpackPlugin =
    (context: GlobalContext, PLUGIN_NAME: string, log: Logger): PluginOptions['webpack'] =>
    (compiler) => {
        compiler.hooks.afterEmit.tap(PLUGIN_NAME, (compilation) => {
            const inputs: Input[] = [];
            const outputs: Output[] = [];
            const entries: Entry[] = [];

            context.build.errors = compilation.errors.map((err) => err.message) || [];
            context.build.warnings = compilation.warnings.map((err) => err.message) || [];

            const warn = (warning: string) => {
                context.build.warnings.push(warning);
                log(warning, 'warn');
            };

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
                reasons: true,
                relatedAssets: true,
                runtime: true,
                runtimeModules: true,
                warnings: true,
            });

            const chunks = stats.chunks || [];
            const assets = stats.assets ? [...stats.assets] : [];
            const modules = stats.modules || [];
            const entrypoints = stats.entrypoints || [];
            const tempSourcemaps: Output[] = [];
            const tempDeps: Record<string, { dependencies: Set<string>; dependents: Set<string> }> =
                {};

            const reportInputsIndexed: Record<string, Input> = {};
            const reportOutputsIndexed: Record<string, Output> = {};

            // In webpack 5, sourcemaps are only stored in asset.related.
            // In webpack 4, sourcemaps are top-level assets.
            // Flatten sourcemaps.
            if (context.bundler.variant === '5' && stats.assets) {
                for (const asset of stats.assets) {
                    if (asset.related) {
                        assets.push(...asset.related);
                    }
                }
            }

            // Build outputs
            for (const asset of assets) {
                const file: Output = {
                    size: asset.size,
                    name: asset.name,
                    inputs: [],
                    filepath: path.join(context.bundler.outDir, asset.name),
                    type: getType(asset.name),
                };

                reportOutputsIndexed[file.filepath] = file;
                outputs.push(file);

                if (file.type === 'map') {
                    tempSourcemaps.push(file);
                }
            }

            // Fill in inputs for sourcemaps.
            for (const sourcemap of tempSourcemaps) {
                const outputFound = reportOutputsIndexed[sourcemap.filepath.replace(/\.map$/, '')];

                if (!outputFound) {
                    warn(`Output not found for ${sourcemap.name}`);
                    continue;
                }

                sourcemap.inputs.push(outputFound);
            }

            // Build inputs
            for (const module of modules) {
                // Do not report runtime modules as they are very specific to webpack.
                if (module.moduleType === 'runtime' || module.name?.startsWith('(webpack)')) {
                    continue;
                }

                const modulePath = module.identifier
                    ? module.identifier
                    : module.name
                      ? path.join(context.cwd, module.name)
                      : 'unknown';

                if (modulePath === 'unknown') {
                    warn(`Unknown module: ${JSON.stringify(module)}`);
                }

                // Get the dependents from its reasons.
                if (module.reasons) {
                    const moduleDeps = tempDeps[modulePath] || {
                        dependencies: new Set(),
                        dependents: new Set(),
                    };

                    const reasons = module.reasons
                        .map((reason) => {
                            const reasonName = reason.resolvedModuleIdentifier
                                ? reason.resolvedModuleIdentifier
                                : reason.moduleIdentifier
                                  ? reason.moduleIdentifier
                                  : reason.resolvedModule
                                    ? path.join(context.cwd, reason.resolvedModule)
                                    : 'unknown';

                            return reasonName;
                        })
                        // We don't want the unknowns.
                        .filter((reason) => reason !== 'unknown');

                    // Store the dependency relationships.
                    for (const reason of reasons) {
                        const reasonDeps = tempDeps[reason] || {
                            dependencies: new Set(),
                            dependents: new Set(),
                        };
                        reasonDeps.dependencies.add(modulePath);
                        tempDeps[reason] = reasonDeps;
                        moduleDeps.dependents.add(reason);
                    }

                    tempDeps[modulePath] = moduleDeps;
                }

                const file: Input = {
                    size: module.size || 0,
                    name: cleanName(context, modulePath),
                    dependencies: new Set(),
                    dependents: new Set(),
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

                    const outputFound = outputs.find((output) => chunkFiles.includes(output.name));
                    if (!outputFound) {
                        warn(`Output not found for ${file.name}`);
                        continue;
                    }

                    outputFound.inputs.push(file);
                }

                reportInputsIndexed[modulePath] = file;
                inputs.push(file);
            }

            const getInput = (filepath: string) => {
                const inputFound = reportInputsIndexed[filepath];
                if (!inputFound) {
                    warn(`Could not find input of ${filepath}`);
                }
                return inputFound;
            };

            // Fill in dependencies and dependents.
            for (const input of inputs) {
                const depsReport = tempDeps[input.filepath];

                if (!depsReport) {
                    warn(`Could not find dependency report for ${input.name}`);
                    continue;
                }

                input.dependencies = cleanReport(depsReport.dependencies, input.filepath, getInput);
                input.dependents = cleanReport(depsReport.dependents, input.filepath, getInput);
            }

            // Build entries
            for (const [name, entry] of Object.entries(entrypoints)) {
                const entryOutputs: Output[] = [];
                const entryInputs: Input[] = [];
                let size = 0;
                // Include sourcemaps in the entry assets.
                const entryAssets = entry.assets || [];
                if (entry.auxiliaryAssets) {
                    entryAssets.push(...entry.auxiliaryAssets);
                }

                for (const asset of entryAssets as any[]) {
                    let assetPath;
                    // Webpack 5 is a list of objects.
                    // Webpack 4 is a list of strings.
                    // We don't want sourcemaps.
                    if (typeof asset === 'string') {
                        assetPath = path.join(context.bundler.outDir, asset);
                    } else if (typeof asset.name === 'string') {
                        assetPath = path.join(context.bundler.outDir, asset.name);
                    }

                    if (!assetPath || !reportOutputsIndexed[assetPath]) {
                        warn(`Could not find output of ${JSON.stringify(asset)}`);
                        continue;
                    }

                    const outputFound = reportOutputsIndexed[assetPath];

                    if (outputFound) {
                        if (outputFound.type !== 'map') {
                            entryOutputs.push(outputFound);
                            // We know it's not a map, so we cast it.
                            entryInputs.push(...(outputFound.inputs as Input[]));
                            // We don't want to include sourcemaps in the sizing.
                            size += outputFound.size;
                        }
                    }
                }

                const assetFound = assets.find((asset) => asset.chunkNames?.includes(name));
                const file: Entry = {
                    name,
                    filepath: assetFound
                        ? path.join(context.bundler.outDir, assetFound.name)
                        : 'unknown',
                    size,
                    inputs: entryInputs,
                    outputs: entryOutputs,
                    type: assetFound ? getType(assetFound.name) : 'unknown',
                };
                entries.push(file);
            }

            context.build.inputs = inputs;
            context.build.outputs = outputs;
            context.build.entries = entries;
        });
    };
