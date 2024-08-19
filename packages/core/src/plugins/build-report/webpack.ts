import { writeFileSync } from 'fs';
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
                    filepath: path.join(context.bundler.outDir, asset.name),
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
                            filepath: path.join(context.bundler.outDir, related.name),
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

                    const sourcemapFound = outputs.find(
                        (output) => output.name === `${file.name}.map`,
                    );
                    // Not a big deal if we don't find one.
                    if (sourcemapFound) {
                        sourcemapFound.inputs.push(file);
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

            writeFileSync(
                `report.${context.bundler.fullName}.json`,
                JSON.stringify(context.build, null, 4),
            );
            writeFileSync(
                `output.${context.bundler.fullName}.json`,
                JSON.stringify(stats, null, 4),
            );

            console.log('END CONTEXT', context.bundler.fullName);
        });
    };
