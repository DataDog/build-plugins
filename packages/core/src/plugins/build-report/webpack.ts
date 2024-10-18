// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/log';
import type {
    Entry,
    GlobalContext,
    Input,
    IterableElement,
    Output,
    PluginOptions,
} from '@dd/core/types';

import { cleanName, getAbsolutePath, getType } from './helpers';

export const getWebpackPlugin =
    (context: GlobalContext, PLUGIN_NAME: string, log: Logger): PluginOptions['webpack'] =>
    (compiler) => {
        const inputs: Input[] = [];
        const outputs: Output[] = [];
        const entries: Entry[] = [];
        const warnings: string[] = [];

        // Some indexes to help with the report generation.
        const reportInputsIndexed: Map<string, Input> = new Map();
        const reportOutputsIndexed: Map<string, Output> = new Map();
        const modulesPerFile: Map<string, string[]> = new Map();

        // Some temporary holders to later fill in more data.
        const tempSourcemaps: Output[] = [];
        const tempDeps: Map<string, { dependencies: Set<string>; dependents: Set<string> }> =
            new Map();

        const isModuleSupported = (moduleIdentifier: string): boolean => {
            return (
                // Ignore unidentified modules and runtimes.
                !!moduleIdentifier &&
                !moduleIdentifier.startsWith('webpack/runtime') &&
                !moduleIdentifier.includes('/webpack4/buildin/') &&
                !moduleIdentifier.startsWith('multi ')
            );
        };

        const warn = (warning: string) => {
            warnings.push(warning);
            log(warning, 'warn');
        };

        /**
         * Let's get build data from webpack 4 and 5.
         *   1. Build a dependency graph from all the initial modules once they're finished
         *       In afterEmit, modules are concatenated and obfuscated.
         *   2. Once the build is finished and emitted, we can compute the outputs and the entries.
         */

        // Intercept the compilation to then get the modules.
        compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
            // Intercept the modules to build the dependency graph.
            compilation.hooks.finishModules.tap(PLUGIN_NAME, (finishedModules) => {
                type Module = IterableElement<typeof finishedModules>;
                type Dependency = IterableElement<
                    Module['dependencies'] | IterableElement<Module['blocks']>['dependencies']
                >;

                // Webpack 4 and 5 have different ways to get the module from a dependency.
                const getModuleFromDep = (dep: Dependency): Module => {
                    return compilation.moduleGraph
                        ? compilation.moduleGraph.getModule(dep)
                        : dep.module;
                };

                for (const module of finishedModules) {
                    const moduleIdentifier = module.identifier();
                    // Dependencies are stored in both dependencies for inline imports and blocks for async imports.
                    const dependencies: Set<string> = new Set(
                        [...module.dependencies, ...module.blocks.flatMap((b) => b.dependencies)]
                            .filter(
                                (dep) =>
                                    // Ignore side effects.
                                    dep.type !== 'harmony side effect evaluation' &&
                                    // Ignore those we can't identify.
                                    getModuleFromDep(dep)?.identifier() &&
                                    // Only what we support.
                                    isModuleSupported(getModuleFromDep(dep)?.identifier()) &&
                                    // Don't add itself as a dependency.
                                    getModuleFromDep(dep)?.identifier() !== moduleIdentifier,
                            )
                            .map((dep) => {
                                return getModuleFromDep(dep)?.identifier();
                            })
                            .filter(Boolean),
                    );

                    if (!isModuleSupported(moduleIdentifier)) {
                        continue;
                    }

                    // Create dependents relationships.
                    for (const depIdentifier of dependencies) {
                        const depDeps = tempDeps.get(depIdentifier) || {
                            dependencies: new Set(),
                            dependents: new Set(),
                        };
                        depDeps.dependents.add(moduleIdentifier);
                        tempDeps.set(depIdentifier, depDeps);
                    }

                    const moduleDeps = tempDeps.get(moduleIdentifier) || {
                        dependents: new Set(),
                        dependencies: new Set(),
                    };

                    for (const moduleDep of dependencies) {
                        moduleDeps.dependencies.add(moduleDep);
                    }

                    // Store the dependencies.
                    tempDeps.set(moduleIdentifier, moduleDeps);

                    // Store the inputs.
                    const file: Input = {
                        size: module.size() || 0,
                        name: cleanName(context, moduleIdentifier),
                        dependencies: new Set(),
                        dependents: new Set(),
                        filepath: moduleIdentifier,
                        type: getType(moduleIdentifier),
                    };
                    inputs.push(file);
                    reportInputsIndexed.set(moduleIdentifier, file);
                }

                // Assign dependencies and dependents.
                for (const input of inputs) {
                    const depsReport = tempDeps.get(input.filepath);

                    if (!depsReport) {
                        warn(`Could not find dependency report for ${input.name}`);
                        continue;
                    }

                    for (const dependency of depsReport.dependencies) {
                        const depInput = reportInputsIndexed.get(dependency);
                        if (!depInput) {
                            warn(`Could not find input of dependency ${dependency}`);
                            continue;
                        }
                        input.dependencies.add(depInput);
                    }

                    for (const dependent of depsReport.dependents) {
                        const depInput = reportInputsIndexed.get(dependent);
                        if (!depInput) {
                            warn(`Could not find input of dependent ${dependent}`);
                            continue;
                        }
                        input.dependents.add(depInput);
                    }
                }
            });
        });

        compiler.hooks.afterEmit.tap(PLUGIN_NAME, (result) => {
            const chunks = result.chunks;
            const assets = result.getAssets();

            const getChunkFiles = (chunk: IterableElement<typeof chunks>) => {
                return [...(chunk.files || []), ...(chunk.auxiliaryFiles || [])].map((f: string) =>
                    getAbsolutePath(context.bundler.outDir, f),
                );
            };

            for (const chunk of chunks) {
                const files = getChunkFiles(chunk);
                const chunkModules = chunk
                    .getModules()
                    .flatMap((m) => {
                        // modules exists but isn't in the types.
                        return 'modules' in m && Array.isArray(m.modules)
                            ? m.modules.map((m2) => m2.identifier())
                            : m.identifier();
                    })
                    .filter(isModuleSupported);

                for (const file of files) {
                    if (getType(file) === 'map') {
                        continue;
                    }
                    const fileModules = modulesPerFile.get(file) || [];
                    modulesPerFile.set(file, [...fileModules, ...chunkModules]);
                }
            }

            // Build outputs
            for (const asset of assets) {
                const file: Output = {
                    size: asset.source.size() || 0,
                    name: asset.name,
                    inputs: [],
                    filepath: getAbsolutePath(context.bundler.outDir, asset.name),
                    type: getType(asset.name),
                };

                reportOutputsIndexed.set(file.filepath, file);
                outputs.push(file);

                // If it's a sourcemap, store it, we'll fill its input when we'll have
                // referenced all the outputs.
                if (file.type === 'map') {
                    tempSourcemaps.push(file);
                    continue;
                }

                // Add the inputs.
                const fileModules = modulesPerFile.get(file.filepath);
                if (!fileModules) {
                    warn(`Could not find modules for ${file.name}`);
                    continue;
                }

                for (const moduleIdentifier of fileModules) {
                    const inputFound = reportInputsIndexed.get(moduleIdentifier);
                    if (!inputFound) {
                        warn(`Could not find input of ${moduleIdentifier}`);
                        continue;
                    }
                    file.inputs.push(inputFound);
                }
            }

            // Fill in inputs for sourcemaps.
            for (const sourcemap of tempSourcemaps) {
                const outputFound = reportOutputsIndexed.get(
                    sourcemap.filepath.replace(/\.map$/, ''),
                );

                if (!outputFound) {
                    warn(`Output not found for sourcemap ${sourcemap.name}`);
                    continue;
                }

                sourcemap.inputs.push(outputFound);
            }

            // Build entries
            for (const [name, entrypoint] of result.entrypoints) {
                const entryOutputs: Output[] = [];
                const entryInputs: Input[] = [];
                let size = 0;
                const entryFiles = entrypoint.chunks.flatMap(getChunkFiles);
                // FIXME This is not a very reliable way to get the entry filename.
                const entryFilename = entrypoint.chunks
                    .filter((c) => c.hasEntryModule())
                    .flatMap((c) => Array.from(c.files))[0];

                for (const file of entryFiles) {
                    const outputFound = reportOutputsIndexed.get(file);
                    if (!file || !outputFound) {
                        warn(`Could not find output of ${JSON.stringify(file)}`);
                        continue;
                    }

                    if (outputFound.type !== 'map' && !entryOutputs.includes(outputFound)) {
                        entryOutputs.push(outputFound);
                        // We know it's not a map, so we cast it.
                        entryInputs.push(...(outputFound.inputs as Input[]));
                        // We don't want to include sourcemaps in the sizing.
                        size += outputFound.size;
                    }
                }

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

            // Save everything in the context.
            context.build.errors = result.errors.map((err) => err.message);
            context.build.warnings = [...warnings, ...result.warnings.map((err) => err.message)];
            context.build.inputs = inputs;
            context.build.outputs = outputs;
            context.build.entries = entries;
        });
    };
