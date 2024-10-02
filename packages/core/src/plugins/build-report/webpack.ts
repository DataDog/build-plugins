// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/log';
import type { Entry, GlobalContext, Input, Output, PluginOptions } from '@dd/core/types';

import { cleanName, cleanReport, getAbsolutePath, getType } from './helpers';

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
                chunkRelations: true,
                entrypoints: true,
                errors: true,
                ids: true,
                modules: true,
                nestedModules: true,
                reasons: true,
                relatedAssets: true,
                warnings: true,
            });

            const chunks = stats.chunks || [];
            const assets = compilation.getAssets();
            const modules: Required<typeof stats.modules> = [];
            const entrypoints = stats.entrypoints || [];

            // Easy type alias.
            type Module = (typeof modules)[number];
            type Reason = NonNullable<Module['reasons']>[number];

            // Some temporary holders to later fill in more data.
            const tempSourcemaps: Output[] = [];
            const tempDeps: Record<string, { dependencies: Set<string>; dependents: Set<string> }> =
                {};

            // Some indexes to help with the report generation.
            const reportInputsIndexed: Record<string, Input> = {};
            const reportOutputsIndexed: Record<string, Output> = {};
            const modulePerId: Map<number | string, Module> = new Map();
            const modulePerIdentifier: Map<string, Module> = new Map();
            const concatModulesPerId: Map<number | string, Module[]> = new Map();
            const concatModulesPerIdentifier: Map<string, Module[]> = new Map();

            // Flatten and index modules.
            // Webpack sometimes groups modules together.
            for (const module of stats.modules || []) {
                if (module.modules) {
                    if (module.id) {
                        concatModulesPerId.set(module.id, module.modules);
                    }
                    if (module.identifier) {
                        concatModulesPerIdentifier.set(module.identifier, module.modules);
                    }

                    for (const subModule of module.modules) {
                        modules.push(subModule);
                        if (subModule.id) {
                            modulePerId.set(subModule.id, subModule);
                        }
                        if (subModule.identifier) {
                            modulePerIdentifier.set(subModule.identifier, subModule);
                        }
                    }
                } else {
                    modules.push(module);
                    if (module.id) {
                        modulePerId.set(module.id, module);
                    }
                    if (module.identifier) {
                        modulePerIdentifier.set(module.identifier, module);
                    }
                }
            }

            // Build outputs
            for (const asset of assets) {
                const file: Output = {
                    size: asset.info.size || 0,
                    name: asset.name,
                    inputs: [],
                    filepath: getAbsolutePath(context.bundler.outDir, asset.name),
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
                    warn(`Output not found for sourcemap ${sourcemap.name}`);
                    continue;
                }

                sourcemap.inputs.push(outputFound);
            }

            const getModulePath = (module: Module) => {
                return module.nameForCondition
                    ? module.nameForCondition
                    : module.name
                      ? getAbsolutePath(context.cwd, module.name)
                      : module.identifier
                        ? module.identifier
                        : 'unknown';
            };

            const getModules = (reason: Reason) => {
                const { moduleIdentifier, moduleId } = reason;
                if (!moduleIdentifier && !moduleId) {
                    return [];
                }

                const modulesFound = [];

                if (moduleId) {
                    const module = modulePerId.get(moduleId);
                    if (module) {
                        modulesFound.push(module);
                    }

                    const concatModules = concatModulesPerId.get(moduleId);
                    if (concatModules) {
                        modulesFound.push(...concatModules);
                    }
                }

                if (moduleIdentifier) {
                    const module = modulePerIdentifier.get(moduleIdentifier);
                    if (module) {
                        modulesFound.push(module);
                    }

                    const concatModules = concatModulesPerIdentifier.get(moduleIdentifier);
                    if (concatModules) {
                        modulesFound.push(...concatModules);
                    }
                }

                return Array.from(new Set(modulesFound.map(getModulePath)));
            };

            // Build inputs
            const modulesDone = new Set<string>();
            for (const module of modules) {
                // Do not report runtime modules as they are very specific to webpack.
                if (
                    module.moduleType === 'runtime' ||
                    module.name?.startsWith('(webpack)') ||
                    module.type === 'orphan modules'
                ) {
                    continue;
                }

                const modulePath = getModulePath(module);
                if (modulesDone.has(modulePath)) {
                    continue;
                }
                modulesDone.add(modulePath);

                if (modulePath === 'unknown') {
                    warn(`Unknown module: ${JSON.stringify(module)}`);
                }

                // Get the dependents from its reasons.
                if (module.reasons) {
                    const moduleDeps = tempDeps[modulePath] || {
                        dependencies: new Set(),
                        dependents: new Set(),
                    };

                    const dependents = module.reasons.flatMap(getModules);

                    // Store the dependency relationships.
                    for (const dependent of dependents) {
                        const reasonDeps = tempDeps[dependent] || {
                            dependencies: new Set(),
                            dependents: new Set(),
                        };
                        reasonDeps.dependencies.add(modulePath);
                        tempDeps[dependent] = reasonDeps;
                        moduleDeps.dependents.add(dependent);
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

                    if (!outputFound.inputs.includes(file)) {
                        outputFound.inputs.push(file);
                    }
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

                const entryAssets = entry.assets || [];
                // Add all the assets to it.
                if (entry.auxiliaryAssets) {
                    entryAssets.push(...entry.auxiliaryAssets);
                }

                for (const asset of entryAssets as any[]) {
                    let assetPath;
                    // Webpack 5 is a list of objects.
                    // Webpack 4 is a list of strings.
                    if (typeof asset === 'string') {
                        assetPath = getAbsolutePath(context.bundler.outDir, asset);
                    } else if (typeof asset.name === 'string') {
                        assetPath = getAbsolutePath(context.bundler.outDir, asset.name);
                    }

                    if (!assetPath || !reportOutputsIndexed[assetPath]) {
                        warn(`Could not find output of ${JSON.stringify(asset)}`);
                        continue;
                    }

                    const outputFound = reportOutputsIndexed[assetPath];

                    if (outputFound) {
                        if (outputFound.type !== 'map' && !entryOutputs.includes(outputFound)) {
                            entryOutputs.push(outputFound);
                            // We know it's not a map, so we cast it.
                            entryInputs.push(...(outputFound.inputs as Input[]));
                            // We don't want to include sourcemaps in the sizing.
                            size += outputFound.size;
                        }
                    }
                }

                // FIXME This is not the right way to get the entry filename.
                const entryFilename = stats.assetsByChunkName?.[name]?.[0];
                const file: Entry = {
                    name,
                    filepath: entryFilename
                        ? getAbsolutePath(context.bundler.outDir, entryFilename)
                        : 'unknown',
                    size,
                    inputs: Array.from(new Set(entryInputs)),
                    outputs: entryOutputs,
                    type: entryFilename ? getType(entryFilename) : 'unknown',
                };
                entries.push(file);
            }

            context.build.inputs = inputs;
            context.build.outputs = outputs;
            context.build.entries = entries;
        });
    };
