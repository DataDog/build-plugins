// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getAbsolutePath } from '@dd/core/helpers/paths';
import { isInjectionFile } from '@dd/core/helpers/plugins';
import type {
    Logger,
    Entry,
    GlobalContext,
    Input,
    IterableElement,
    Output,
    PluginOptions,
} from '@dd/core/types';

import { cleanName, getType } from './helpers';

export const getXpackPlugin =
    (
        context: GlobalContext,
        PLUGIN_NAME: string,
        log: Logger,
    ): PluginOptions['rspack'] & PluginOptions['webpack'] =>
    (compiler) => {
        const inputs: Input[] = [];
        const outputs: Output[] = [];
        const entries: Entry[] = [];

        // Types for the xpack hooks.
        type Compilation = Parameters<Parameters<typeof compiler.hooks.thisCompilation.tap>[1]>[0];
        type Module = IterableElement<
            Parameters<Parameters<Compilation['hooks']['finishModules']['tap']>[1]>[0]
        >;
        type Dependency = IterableElement<IterableElement<Module['blocks']>['dependencies']>;
        type Chunk = IterableElement<Compilation['chunks']>;

        // Some indexes to help with the report generation.
        const reportInputsIndexed: Map<string, Input> = new Map();
        const reportOutputsIndexed: Map<string, Output> = new Map();
        const modulesPerFile: Map<string, string[]> = new Map();
        const moduleIndex: Map<string, Module> = new Map();

        // Some temporary holders to later fill in more data.
        const tempSourcemaps: Output[] = [];
        const tempDeps: Map<string, { dependencies: Set<string>; dependents: Set<string> }> =
            new Map();

        const timeBuildReport = log.time('build report', { start: false });

        const isModuleSupported = (moduleIdentifier?: string): boolean => {
            return (
                // Ignore unidentified modules and runtimes.
                !!moduleIdentifier &&
                !moduleIdentifier.startsWith('webpack/runtime') &&
                !moduleIdentifier.includes('/webpack4/buildin/') &&
                !moduleIdentifier.startsWith('multi ') &&
                !isInjectionFile(moduleIdentifier)
            );
        };

        /**
         * Let's get build data from webpack 4 and 5.
         *   1. Build a dependency graph from all the initial modules once they're finished
         *       In afterEmit, modules are concatenated and obfuscated.
         *   2. Once the build is finished and emitted, we can compute the outputs and the entries.
         */

        const cleanExternalName = (name: string) => {
            // Removes "external " prefix and surrounding quotes from external dependency names
            // Example: 'external var "lodash"' -> 'lodash'
            return name.replace(/(^external[^"]+"|"$)/g, '');
        };

        // Index the module by its identifier, resource, request, rawRequest, and userRequest.
        const getKeysToIndex = (mod: Module): Set<string> => {
            const values: Record<string, string> = {
                identifier: mod.identifier(),
            };

            if ('resource' in mod && typeof mod.resource === 'string') {
                values.resource = mod.resource;
            }
            if ('request' in mod && typeof mod.request === 'string') {
                values.request = mod.request;
            }
            if ('rawRequest' in mod && typeof mod.rawRequest === 'string') {
                values.rawRequest = mod.rawRequest;
            }
            if ('userRequest' in mod && typeof mod.userRequest === 'string') {
                values.userRequest = mod.userRequest;
            }

            const keysToIndex: Set<string> = new Set();

            for (const [key, value] of Object.entries(values)) {
                if (!value) {
                    continue;
                }

                if (moduleIndex.has(value)) {
                    log.debug(`Module ${mod.identifier()} is already indexed by ${key}.`);
                    if (moduleIndex.get(value) !== mod) {
                        log.debug(`Module ${mod.identifier()} is indexed with a different value.`);
                    }
                } else {
                    keysToIndex.add(value);
                    // RSpack only use "external ..." for external dependencies.
                    // So we need to clean and add the actual name to the index too.
                    if (value.startsWith('external ')) {
                        keysToIndex.add(cleanExternalName(value));
                    }
                }
            }

            return keysToIndex;
        };

        // Aggregate all dependencies from a module.
        const getAllDependencies = (
            module: Module | Dependency | Module['blocks'][number],
            dependencies: Dependency[] = [],
        ) => {
            if ('dependencies' in module) {
                for (const dependency of module.dependencies) {
                    dependencies.push(dependency);
                    getAllDependencies(dependency, dependencies);
                }
            }

            if ('blocks' in module) {
                for (const block of module.blocks) {
                    getAllDependencies(block, dependencies);
                }
            }

            return dependencies;
        };

        const getModuleFromDep = (mod: Module, dep: Dependency): Module | undefined => {
            if ('request' in dep && dep.request) {
                if (moduleIndex.has(dep.request)) {
                    return moduleIndex.get(dep.request);
                }
                if (mod.context && moduleIndex.has(getAbsolutePath(mod.context, dep.request))) {
                    return moduleIndex.get(getAbsolutePath(mod.context, dep.request));
                }
            }
        };

        const isExternal = (mod: Module) => {
            if ('externalType' in mod && mod.externalType) {
                return true;
            }
            if ('external' in mod && mod.external) {
                return true;
            }
            if (mod.identifier?.().startsWith('external ')) {
                return true;
            }
            return false;
        };

        // Intercept the compilation to then get the modules.
        compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
            // Intercept the modules to build the dependency graph.
            compilation.hooks.finishModules.tap(
                PLUGIN_NAME,
                (finishedModules: Iterable<Module>) => {
                    timeBuildReport.resume();
                    const timeGraph = log.time('dependency graph');
                    // First loop to create indexes.
                    const timeIndex = log.time('indexing modules');
                    for (const module of finishedModules) {
                        const keysToIndex = getKeysToIndex(module);
                        for (const key of keysToIndex) {
                            moduleIndex.set(key, module);
                        }
                    }
                    timeIndex.end();

                    // Second loop to create the dependency graph.
                    const timeInputs = log.time('building inputs');
                    for (const module of finishedModules) {
                        const moduleIdentifier = module.identifier();
                        const moduleName = cleanName(context, moduleIdentifier);
                        const dependencies: Set<string> = new Set(
                            getAllDependencies(module)
                                .map((dep) => {
                                    const mod = getModuleFromDep(module, dep);

                                    // Ignore those we can't identify.
                                    if (!mod?.identifier()) {
                                        return false;
                                    }

                                    const identifier = mod.identifier();

                                    // Only what we support.
                                    if (!isModuleSupported(identifier)) {
                                        return false;
                                    }

                                    // Don't add itself as a dependency.
                                    if (identifier === moduleIdentifier) {
                                        return false;
                                    }

                                    return isExternal(mod)
                                        ? cleanExternalName(identifier)
                                        : identifier;
                                })
                                .filter(Boolean) as string[],
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
                        const file: Input = isExternal(module)
                            ? {
                                  size: 0,
                                  name: cleanExternalName(moduleName),
                                  dependencies: new Set(),
                                  dependents: new Set(),
                                  filepath: moduleIdentifier,
                                  type: 'external',
                              }
                            : {
                                  size: module.size() || 0,
                                  name: moduleName,
                                  dependencies: new Set(),
                                  dependents: new Set(),
                                  filepath: moduleIdentifier,
                                  type: getType(moduleIdentifier),
                              };

                        inputs.push(file);
                        reportInputsIndexed.set(moduleIdentifier, file);

                        // If it's an external dependency, we also need to index it by its cleaned name.
                        if (isExternal(module)) {
                            reportInputsIndexed.set(cleanExternalName(moduleIdentifier), file);
                        }
                    }
                    timeInputs.end();

                    // Assign dependencies and dependents.
                    const timeAssign = log.time('assigning dependencies and dependents');
                    for (const input of inputs) {
                        const depsReport = tempDeps.get(input.filepath);

                        if (!depsReport) {
                            log.debug(`Could not find dependency report for ${input.name}`);
                            continue;
                        }

                        for (const dependency of depsReport.dependencies) {
                            const depInput = reportInputsIndexed.get(dependency);
                            if (!depInput) {
                                log.debug(`Could not find input of dependency ${dependency}`);
                                continue;
                            }
                            input.dependencies.add(depInput);
                        }

                        for (const dependent of depsReport.dependents) {
                            const depInput = reportInputsIndexed.get(dependent);
                            if (!depInput) {
                                log.debug(`Could not find input of dependent ${dependent}`);
                                continue;
                            }
                            input.dependents.add(depInput);
                        }
                    }
                    timeAssign.end();
                    timeGraph.end();
                    timeBuildReport.pause();
                },
            );
        });

        compiler.hooks.afterEmit.tap(PLUGIN_NAME, (result: Compilation) => {
            timeBuildReport.resume();
            const chunks = result.chunks;
            const assets = result.getAssets();

            const getChunkFiles = (chunk: Chunk) => {
                return [...(chunk.files || []), ...(chunk.auxiliaryFiles || [])].map((f: string) =>
                    getAbsolutePath(context.bundler.outDir, f),
                );
            };

            const timeChunks = log.time('indexing chunks');
            const chunkGraph = result.chunkGraph;
            for (const chunk of chunks) {
                const files = getChunkFiles(chunk);

                const chunkModules = (
                    chunkGraph
                        ? // @ts-expect-error: Reconciliating Webpack 4, Webpack 5 and Rspack is hard.
                          chunkGraph?.getChunkModules(chunk)
                        : // This one is for webpack 4.
                          'getModules' in chunk && typeof chunk.getModules === 'function'
                          ? (chunk.getModules() as Module[])
                          : []
                )
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
            timeChunks.end();

            // Build outputs
            const timeOutputs = log.time('building outputs');
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
                    log.debug(`Could not find modules for ${file.name}`);
                    continue;
                }

                for (const moduleIdentifier of fileModules) {
                    const inputFound = reportInputsIndexed.get(moduleIdentifier);
                    if (!inputFound) {
                        log.debug(`Could not find input of ${moduleIdentifier}`);
                        continue;
                    }
                    file.inputs.push(inputFound);
                }
            }
            timeOutputs.end();

            // Fill in inputs for sourcemaps.
            const timeSourcemaps = log.time('filling sourcemaps inputs');
            for (const sourcemap of tempSourcemaps) {
                const outputFound = reportOutputsIndexed.get(
                    sourcemap.filepath.replace(/\.map$/, ''),
                );

                if (!outputFound) {
                    log.debug(`Output not found for sourcemap ${sourcemap.name}`);
                    continue;
                }

                sourcemap.inputs.push(outputFound);
            }
            timeSourcemaps.end();

            // Build entries
            const timeEntries = log.time('building entries');
            for (const [name, entrypoint] of result.entrypoints) {
                const entryOutputs: Output[] = [];
                const entryInputs: Input[] = [];
                let size = 0;
                const entryFiles = entrypoint.chunks.flatMap(getChunkFiles);
                // FIXME This is not a 100% reliable way to get the entry filename.
                const entryFilename = entrypoint.chunks
                    // Get the chunks that have entry modules.
                    .filter((chunk: Chunk) =>
                        chunkGraph
                            ? // @ts-expect-error: Reconciliating Webpack 4, Webpack 5 and Rspack is hard.
                              chunkGraph.getChunkEntryModulesIterable(chunk)
                            : // This one is for webpack 4.
                              'hasEntryModule' in chunk &&
                                typeof chunk.hasEntryModule === 'function'
                              ? chunk.hasEntryModule()
                              : false,
                    )
                    // Get the files of those chunks.
                    .flatMap((c) => Array.from(c.files))
                    // Filter the ones that includes the entry name.
                    .filter(
                        (f) => f.includes(name) || (entrypoint.name && f.includes(entrypoint.name)),
                    )
                    // Only keep JS files.
                    .find((f) => getType(f) === 'js');

                for (const file of entryFiles) {
                    const outputFound = reportOutputsIndexed.get(file);
                    if (!file || !outputFound) {
                        log.debug(`Could not find output of ${JSON.stringify(file)}`);
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
            timeEntries.end();

            // Save everything in the context.
            for (const error of result.errors) {
                context.build.errors.push(error.message);
            }
            for (const warning of result.warnings) {
                context.build.warnings.push(warning.message);
            }
            context.build.inputs = inputs;
            context.build.outputs = outputs;
            context.build.entries = entries;

            timeBuildReport.end();
            context.hook('buildReport', context.build);
        });
    };
