// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getAbsolutePath } from '@dd/core/helpers/paths';
import type { Logger, Entry, GlobalContext, Input, Output, PluginOptions } from '@dd/core/types';

import { cleanName, cleanPath, cleanReport, getType } from './helpers';

export const getRollupPlugin = (context: GlobalContext, log: Logger): PluginOptions['rollup'] => {
    const timeModuleParsing = log.time('module parsing', { start: false });
    const timeBuildReport = log.time('build report', { start: false });
    const timeEntries = log.time('filling entries', { start: false });
    const timeInputsOutputs = log.time('filling inputs and outputs', { start: false });
    const timeCompleteDeps = log.time('completing dependencies and dependents', { start: false });
    const timeDeps = log.time('filling dependencies and dependents', { start: false });
    const timeSourcemaps = log.time('filling sourcemaps inputs', { start: false });

    const inputs: Map<string, Input> = new Map();
    const outputs: Map<string, Output> = new Map();
    const entries: Map<string, Entry> = new Map();
    const importsReport: Map<
        string,
        {
            dependencies: Set<string>;
            dependents: Set<string>;
        }
    > = new Map();

    return {
        buildStart() {
            // Start clean to avoid build up in case of multiple builds.
            // It's useful with a dev server or a build with multiple outputs.
            importsReport.clear();
            inputs.clear();
            outputs.clear();
            entries.clear();
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
        moduleParsed(info) {
            timeModuleParsing.resume();
            // Store import infos.
            const cleanId = cleanPath(info.id);
            const report = importsReport.get(cleanId) || {
                dependencies: new Set(),
                dependents: new Set(),
            };

            // Clean new dependencies and dependents.
            const newDependencies = cleanReport(
                new Set([...info.dynamicallyImportedIds, ...info.importedIds]),
                cleanId,
            );

            const newDependents = cleanReport(
                new Set([...info.dynamicImporters, ...info.importers]),
                cleanId,
            );

            for (const dependent of newDependents) {
                report.dependents.add(dependent);
            }

            for (const dependency of newDependencies) {
                report.dependencies.add(dependency);
            }

            importsReport.set(cleanId, report);
            timeModuleParsing.tag([`module:${cleanId}`], { span: true });
            timeModuleParsing.pause();
        },
        // This can be called multiple times depending on the number of output configured.
        writeBundle(options, bundle) {
            timeBuildReport.resume();
            const outDir = options.dir
                ? getAbsolutePath(context.buildRoot, options.dir)
                : context.bundler.outDir;

            const tempEntryFiles: Set<Entry> = new Set();
            const tempSourcemaps: Set<Output> = new Set();
            const tempOutputsImports: Map<string, Output> = new Map();

            // Complete the importsReport with missing dependents and dependencies.
            timeCompleteDeps.resume();
            for (const [filepath, { dependencies, dependents }] of importsReport) {
                for (const dependency of dependencies) {
                    const cleanedDependency = cleanPath(dependency);
                    const report = importsReport.get(cleanedDependency) || {
                        dependencies: new Set(),
                        dependents: new Set(),
                    };

                    if (report.dependents.has(filepath)) {
                        continue;
                    }

                    report.dependents.add(filepath);
                    importsReport.set(cleanedDependency, report);
                }

                for (const dependent of dependents) {
                    const cleanedDependent = cleanPath(dependent);
                    const report = importsReport.get(cleanedDependent) || {
                        dependencies: new Set(),
                        dependents: new Set(),
                    };

                    if (report.dependencies.has(filepath)) {
                        continue;
                    }

                    report.dependencies.add(filepath);
                    importsReport.set(cleanedDependent, report);
                }
            }
            timeCompleteDeps.end();

            // Fill in inputs and outputs.
            timeInputsOutputs.resume();
            for (const [filename, asset] of Object.entries(bundle)) {
                const filepath = getAbsolutePath(outDir, filename);
                const size =
                    'code' in asset
                        ? Buffer.byteLength(asset.code, 'utf8')
                        : Buffer.byteLength(asset.source, 'utf8');

                const file: Output = outputs.get(filepath) || {
                    name: filename,
                    filepath,
                    inputs: [],
                    size,
                    type: getType(filename),
                };

                // Store sourcemaps for later filling.
                // Because we may not have reported its input yet.
                if (file.type === 'map') {
                    tempSourcemaps.add(file);
                }

                if ('modules' in asset) {
                    for (const [modulepath, module] of Object.entries(asset.modules)) {
                        // We don't want to include commonjs wrappers and proxies that are like:
                        // \u0000{{path}}?commonjs-proxy
                        if (cleanPath(modulepath) !== modulepath) {
                            continue;
                        }
                        const moduleFile: Input = inputs.get(modulepath) || {
                            name: cleanName(outDir, modulepath),
                            dependencies: new Set(),
                            dependents: new Set(),
                            filepath: modulepath,
                            // Since we store as input, we use the originalLength.
                            size: module.originalLength,
                            type: getType(modulepath),
                        };
                        file.inputs.push(moduleFile);
                        inputs.set(moduleFile.filepath, moduleFile);
                    }
                }

                // Add imports as inputs.
                // These are external imports since they are declared in the output file.
                if ('imports' in asset) {
                    for (const importName of asset.imports) {
                        const cleanedImport = cleanPath(importName);
                        if (!importsReport.has(cleanedImport)) {
                            // We may not have this yet as it could be one of the chunks
                            // produced by the current build.
                            tempOutputsImports.set(getAbsolutePath(outDir, cleanedImport), file);
                            continue;
                        }

                        if (inputs.has(cleanedImport)) {
                            log.debug(
                                `Input report already there for ${cleanedImport} from ${file.name}.`,
                            );
                            continue;
                        }

                        const importFile: Input = inputs.get(cleanedImport) || {
                            name: cleanName(outDir, importName),
                            dependencies: new Set(),
                            dependents: new Set(),
                            filepath: cleanedImport,
                            // Since it's external, we don't have the size.
                            size: 0,
                            type: 'external',
                        };
                        file.inputs.push(importFile);
                        inputs.set(importFile.filepath, importFile);
                    }
                }

                // Store entries for later filling.
                // As we may not have reported its outputs and inputs yet.
                if ('isEntry' in asset && asset.isEntry) {
                    tempEntryFiles.add({ ...file, name: asset.name, size: 0, outputs: [file] });
                }

                outputs.set(file.filepath, file);
            }
            timeInputsOutputs.end();

            for (const [filepath, output] of tempOutputsImports) {
                const outputReport = outputs.get(filepath);
                if (!outputReport) {
                    log.debug(`Could not find the output report for ${filepath}.`);
                    continue;
                }

                if (!output.inputs.includes(outputReport)) {
                    output.inputs.push(outputReport);
                }
            }

            // Fill in inputs' dependencies and dependents.
            timeDeps.resume();
            for (const [filepath, input] of inputs) {
                const importReport = importsReport.get(filepath);
                if (!importReport) {
                    log.debug(`Could not find the import report for ${input.name}.`);
                    continue;
                }

                for (const dependency of importReport.dependencies) {
                    const foundInput = inputs.get(dependency);
                    if (!foundInput) {
                        log.debug(
                            `Could not find input for dependency ${cleanName(outDir, dependency)} of ${input.name}`,
                        );
                        continue;
                    }
                    input.dependencies.add(foundInput);
                }

                for (const dependent of importReport.dependents) {
                    const foundInput = inputs.get(dependent);
                    if (!foundInput) {
                        log.debug(
                            `Could not find input for dependent ${cleanName(outDir, dependent)} of ${input.name}`,
                        );
                        continue;
                    }
                    input.dependents.add(foundInput);
                }
            }
            timeDeps.end();

            // Fill in sourcemaps' inputs if necessary
            if (tempSourcemaps.size) {
                timeSourcemaps.resume();
                for (const sourcemap of tempSourcemaps) {
                    const outputPath = sourcemap.filepath.replace(/\.map$/, '');
                    const foundOutput = outputs.get(outputPath);

                    if (!foundOutput) {
                        log.debug(`Could not find output for sourcemap ${sourcemap.name}`);
                        continue;
                    }

                    sourcemap.inputs.push(foundOutput);
                }
                timeSourcemaps.end();
            }

            // Gather all outputs from a filepath, following imports.
            const getAllOutputs = (
                filepath: string,
                allOutputs: Map<string, Output> = new Map(),
            ) => {
                // We already processed it.
                if (allOutputs.has(filepath)) {
                    return allOutputs;
                }
                const filename = cleanName(outDir, filepath);

                // Get its output.
                const foundOutput = outputs.get(filepath);
                if (!foundOutput) {
                    // If it's been reported in the inputs, it means it's an external here.
                    // Do not log about externals, we don't expect to find them.
                    if (!inputs.has(filename)) {
                        log.debug(`Could not find output for ${filename}`);
                    }
                    return allOutputs;
                }
                allOutputs.set(filepath, foundOutput);

                // Rollup indexes on the filepath relative to the outDir.
                const asset = bundle[cleanName(outDir, filepath)];
                if (!asset) {
                    log.debug(`Could not find asset for ${filename}`);
                    return allOutputs;
                }

                // Imports are stored in two different places.
                const imports = [];
                if ('imports' in asset) {
                    imports.push(...asset.imports);
                }
                if ('dynamicImports' in asset) {
                    imports.push(...asset.dynamicImports);
                }

                for (const importName of imports) {
                    getAllOutputs(getAbsolutePath(outDir, importName), allOutputs);
                }

                return allOutputs;
            };

            // Fill in entries
            timeEntries.resume();
            for (const entryFile of tempEntryFiles) {
                const entryOutputs = getAllOutputs(entryFile.filepath);
                entryFile.outputs = Array.from(entryOutputs.values());

                // NOTE: This might not be as accurate as expected, some inputs could be side-effects.
                // Rollup doesn't provide a way to get the imports of an input.
                entryFile.inputs = Array.from(
                    new Set(entryFile.outputs.flatMap((output) => output.inputs)),
                );
                entryFile.size = entryFile.outputs.reduce((acc, output) => acc + output.size, 0);

                if (entries.has(entryFile.filepath)) {
                    log.debug(
                        `Entry "${entryFile.name}":"${cleanName(outDir, entryFile.filepath)}" already reported.`,
                    );
                }

                entries.set(entryFile.filepath, entryFile);
            }
            timeEntries.pause();
            timeBuildReport.pause();
        },
        async closeBundle() {
            context.build.inputs = Array.from(inputs.values());
            context.build.outputs = Array.from(outputs.values());
            context.build.entries = Array.from(entries.values());

            timeEntries.end();
            timeBuildReport.end();

            await context.asyncHook('buildReport', context.build);
        },
    };
};
