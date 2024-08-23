// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';
import type { UnpluginOptions } from 'unplugin';

import type { Logger } from '../../log';
import type { Entry, File, GlobalContext, Output } from '../../types';

import { cleanName, getType } from './helpers';

export const getWebpackPlugin =
    (context: GlobalContext, PLUGIN_NAME: string, log: Logger): UnpluginOptions['webpack'] =>
    (compiler) => {
        compiler.hooks.afterEmit.tap(PLUGIN_NAME, (compilation) => {
            const inputs: File[] = [];
            const outputs: Output[] = [];
            const entries: Entry[] = [];

            context.build.errors = compilation.errors.map((err) => err.message) || [];
            context.build.warnings = compilation.warnings.map((err) => err.message) || [];

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
            const assets = stats.assets ? [...stats.assets] : [];
            const modules = stats.modules || [];
            const entrypoints = stats.entrypoints || [];
            const tempSourcemaps = [];

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
                outputs.push(file);

                if (file.type === 'map') {
                    tempSourcemaps.push(file);
                }
            }

            // Fill in inputs for sourcemaps.
            for (const sourcemap of tempSourcemaps) {
                const outputFound = outputs.find(
                    (output) => output.name === sourcemap.name.replace('.map', ''),
                );

                if (!outputFound) {
                    log(`Output not found for ${sourcemap.name}`, 'warn');
                    continue;
                }

                sourcemap.inputs.push(outputFound);
            }

            // Build inputs
            for (const module of modules) {
                // Do not report runtime modules as they are only available in webpack 5.
                if (module.type === 'runtime' || module.moduleType === 'runtime') {
                    continue;
                }

                const modulePath = module.identifier
                    ? module.identifier
                    : module.name
                      ? path.join(context.cwd, module.name)
                      : 'unknown';

                if (modulePath === 'unknown') {
                    log(`Unknown module: ${JSON.stringify(module)}`, 'warn');
                }

                const file: File = {
                    size: module.size || 0,
                    name: cleanName(context, modulePath),
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
                        log(`Output not found for ${file.name}`, 'warn');
                        continue;
                    }
                    outputFound.inputs.push(file);
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

                for (const asset of entryAssets as any[]) {
                    let outputFound;
                    // Webpack 5 is a list of objects.
                    // Webpack 4 is a list of strings.
                    // We don't want sourcemaps.
                    if (typeof asset === 'string' && !asset.endsWith('.map')) {
                        outputFound = outputs.find((output) => output.name === asset);
                    } else if (typeof asset.name === 'string' && !asset.name.endsWith('.map')) {
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
