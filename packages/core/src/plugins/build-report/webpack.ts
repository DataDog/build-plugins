// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { isInjectionFile } from '@dd/core/helpers';
import type { Logger } from '@dd/core/log';
import type {
    ArrayElement,
    Entry,
    GlobalContext,
    Input,
    Output,
    PluginOptions,
    WithRequired,
} from '@dd/core/types';
import fs from 'fs';

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

            fs.writeFileSync(`./stats.json`, JSON.stringify(stats, null, 4), { encoding: 'utf-8' });

            // Easy type alias.
            type Module = WithRequired<ArrayElement<NonNullable<typeof stats.modules>>, 'reasons'>;
            type Reason = Module['reasons'][number];

            const chunks = stats.chunks || [];
            const assets = compilation.getAssets();
            const modules: Module[] = [];
            const entrypoints = stats.entrypoints || [];

            // type Module = ArrayElement<typeof modules>;

            // Some temporary holders to later fill in more data.
            const tempSourcemaps: Output[] = [];
            const tempDeps: Record<string, { dependencies: Set<string>; dependents: Set<string> }> =
                {};

            // Some indexes to help with the report generation.
            const reportInputsIndexed: Record<string, Input> = {};
            const reportOutputsIndexed: Record<string, Output> = {};
            const modulePerId: Map<number | string, Module> = new Map();
            const modulePerIdentifier: Map<string, Module> = new Map();

            const getModulePath = (module: Module) => {
                return module.nameForCondition
                    ? module.nameForCondition
                    : module.name
                      ? getAbsolutePath(context.cwd, module.name)
                      : module.identifier
                        ? module.identifier
                        : 'unknown';
            };

            const isModuleSupported = (module: (typeof modules)[number]) => {
                if (
                    isInjectionFile(getModulePath(module)) ||
                    // Do not report runtime modules as they are very specific to webpack.
                    module.moduleType === 'runtime' ||
                    module.name?.startsWith('(webpack)') ||
                    // Also ignore orphan modules
                    module.type === 'orphan modules'
                ) {
                    return false;
                }
                return true;
            };

            // Flatten and index modules.
            // Webpack sometimes groups modules together.
            for (const module of stats.modules || []) {
                const modulesToSave: Module[] = [];
                if (module.modules) {
                    for (const subModule of module.modules) {
                        modulesToSave.push({
                            ...subModule,
                            // We need to include all the chunks it's part of.
                            // Parent and itself.
                            chunks: Array.from(
                                new Set([...(module.chunks || []), ...(subModule.chunks || [])]),
                            ),
                            reasons: subModule.reasons || [],
                        });
                    }
                } else {
                    modulesToSave.push({ ...module, reasons: module.reasons || [] });
                }

                // Final modifications to the modules.
                for (const moduleToSave of modulesToSave) {
                    if (!isModuleSupported(moduleToSave)) {
                        continue;
                    }

                    // We need to add the issuer if present in order
                    // not to lose the dependency track in webpack5 that doesn't
                    // report the entry module independently.
                    if (moduleToSave.issuer || moduleToSave.issuerId) {
                        moduleToSave.reasons.push({
                            active: true,
                            moduleIdentifier: moduleToSave.issuer,
                            moduleId: moduleToSave.issuerId,
                        });
                    }

                    moduleToSave.reasons = moduleToSave.reasons
                        // Only keep the reasons that are identifiable.
                        .filter((reason) => reason.moduleId || reason.moduleIdentifier)
                        // Webpack5 has a resolvedModuleIdentifier that points to the actual module
                        // instead of the concatenated one.
                        .map((reason) => {
                            return {
                                ...reason,
                                moduleIdentifier:
                                    reason.resolvedModuleIdentifier || reason.moduleIdentifier,
                            };
                        });

                    // Only store and index it if we can actually identify it.
                    if (!moduleToSave.id && !moduleToSave.identifier) {
                        continue;
                    }

                    modules.push(moduleToSave);
                    if (moduleToSave.id) {
                        modulePerId.set(moduleToSave.id, moduleToSave);
                    }
                    if (moduleToSave.identifier) {
                        modulePerIdentifier.set(moduleToSave.identifier, moduleToSave);
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

            const getModules = (reason: Reason) => {
                // Ignore side-effects.
                if (reason.type === 'harmony side effect evaluation') {
                    return [];
                }

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
                }

                if (moduleIdentifier) {
                    const module = modulePerIdentifier.get(moduleIdentifier);
                    if (module) {
                        modulesFound.push(module);
                    }
                }

                return modulesFound.map(getModulePath);
            };

            // Build inputs
            const modulesDone = new Set<string>();
            for (const module of modules) {
                const modulePath = getModulePath(module);
                if (modulesDone.has(modulePath)) {
                    continue;
                }
                modulesDone.add(modulePath);

                if (modulePath === 'unknown') {
                    warn(`Unknown module: ${JSON.stringify(module)}`);
                }

                // Get the dependents from its reasons.
                const moduleDeps = tempDeps[modulePath] || {
                    dependencies: new Set(),
                    dependents: new Set(),
                };

                if (module.reasons.length) {
                    // console.log(
                    //     'REASONS',
                    //     context.bundler.fullName,
                    //     modulePath,
                    //     module.reasons.map((r) => r.moduleIdentifier).sort(),
                    // );
                    const dependents = Array.from(new Set(module.reasons.flatMap(getModules)));
                    // if (!module.name?.includes('node_modules')) {
                    //     console.log(
                    //         context.bundler.fullName.toUpperCase(),
                    //         'DEPENDENTS',
                    //         module.name,
                    //         dependents.length,
                    //         dependents.sort(),
                    //     );
                    // }

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
                }

                tempDeps[modulePath] = moduleDeps;

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

                    // A module can be bundled in more than one output.
                    const outputsFound = outputs.filter((output) =>
                        chunkFiles.includes(output.name),
                    );

                    if (!outputsFound.length) {
                        warn(`Output not found for ${file.name}`);
                        continue;
                    }

                    for (const outputFound of outputsFound) {
                        if (!outputFound.inputs.includes(file)) {
                            outputFound.inputs.push(file);
                        }
                    }
                }

                reportInputsIndexed[modulePath] = file;
                inputs.push(file);
            }

            console.log('TEMP DEPS', context.bundler.fullName, tempDeps);

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
                            // console.log(
                            //     'OUTPUT FOUND',
                            //     context.bundler.fullName,
                            //     name,
                            //     outputFound.name,
                            //     outputFound.inputs.length,
                            //     outputFound.inputs.map((i) => i.name).sort(),
                            // );
                            entryOutputs.push(outputFound);
                            // We know it's not a map, so we cast it.
                            entryInputs.push(...(outputFound.inputs as Input[]));
                            // We don't want to include sourcemaps in the sizing.
                            size += outputFound.size;
                        }
                    }
                }

                // FIXME This is not the right way to get the entry filename.
                const entryFilename = stats.assetsByChunkName?.[name]?.[0].replace(/\.map$/, '');
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
                // console.log(
                //     'ENTRY',
                //     context.bundler.fullName,
                //     name,
                //     entryFilename,
                //     file.inputs.length,
                //     file.inputs.map((i) => i.name).sort(),
                // );
                entries.push(file);
            }

            context.build.inputs = inputs;
            context.build.outputs = outputs;
            context.build.entries = entries;
        });
    };
