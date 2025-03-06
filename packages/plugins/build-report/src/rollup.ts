// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, Entry, GlobalContext, Input, Output, PluginOptions } from '@dd/core/types';

import { cleanName, cleanPath, cleanReport, getAbsolutePath, getType } from './helpers';

export const getRollupPlugin = (context: GlobalContext, log: Logger): PluginOptions['rollup'] => {
    const importsReport: Record<
        string,
        {
            dependencies: Set<string>;
            dependents: Set<string>;
        }
    > = {};
    return {
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
            // Store import infos.
            const cleanId = cleanPath(info.id);
            const report = importsReport[cleanId] || {
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

            importsReport[cleanId] = report;
        },
        writeBundle(options, bundle) {
            const buildReportEnd = log.time('build report');
            const inputs: Input[] = [];
            const outputs: Output[] = [];
            const tempEntryFiles: Entry[] = [];
            const tempSourcemaps: Output[] = [];
            const entries: Entry[] = [];

            const reportInputsIndexed: Record<string, Input> = {};
            const reportOutputsIndexed: Record<string, Output> = {};

            // Complete the importsReport with missing dependents and dependencies.
            const depsCompleteEnd = log.time('completing dependencies and dependents');
            for (const [filepath, { dependencies, dependents }] of Object.entries(importsReport)) {
                for (const dependency of dependencies) {
                    const cleanedDependency = cleanPath(dependency);
                    if (!importsReport[cleanedDependency]) {
                        importsReport[cleanedDependency] = {
                            dependencies: new Set(),
                            dependents: new Set(),
                        };
                    }

                    if (importsReport[cleanedDependency].dependents.has(filepath)) {
                        continue;
                    }

                    importsReport[cleanedDependency].dependents.add(filepath);
                }

                for (const dependent of dependents) {
                    const cleanedDependent = cleanPath(dependent);
                    if (!importsReport[cleanedDependent]) {
                        importsReport[cleanedDependent] = {
                            dependencies: new Set(),
                            dependents: new Set(),
                        };
                    }

                    if (importsReport[cleanedDependent].dependencies.has(filepath)) {
                        continue;
                    }

                    importsReport[cleanedDependent].dependencies.add(filepath);
                }
            }
            depsCompleteEnd();

            // Fill in inputs and outputs.
            const inputsOutputsEnd = log.time('filling inputs and outputs');
            for (const [filename, asset] of Object.entries(bundle)) {
                const filepath = getAbsolutePath(context.bundler.outDir, filename);
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

                // Store sourcemaps for later filling.
                // Because we may not have reported its input yet.
                if (file.type === 'map') {
                    tempSourcemaps.push(file);
                }

                if ('modules' in asset) {
                    for (const [modulepath, module] of Object.entries(asset.modules)) {
                        // We don't want to include commonjs wrappers that have a path like:
                        // \u0000{{path}}?commonjs-proxy
                        if (cleanPath(modulepath) !== modulepath) {
                            continue;
                        }
                        const moduleFile: Input = {
                            name: cleanName(context, modulepath),
                            dependencies: new Set(),
                            dependents: new Set(),
                            filepath: modulepath,
                            // Since we store as input, we use the originalLength.
                            size: module.originalLength,
                            type: getType(modulepath),
                        };
                        file.inputs.push(moduleFile);

                        reportInputsIndexed[moduleFile.filepath] = moduleFile;
                        inputs.push(moduleFile);
                    }
                }

                // Store entries for later filling.
                // As we may not have reported its outputs and inputs yet.
                if ('isEntry' in asset && asset.isEntry) {
                    tempEntryFiles.push({ ...file, name: asset.name, size: 0, outputs: [file] });
                }

                reportOutputsIndexed[file.filepath] = file;
                outputs.push(file);
            }
            inputsOutputsEnd();

            // Fill in inputs' dependencies and dependents.
            const depsEnd = log.time('filling dependencies and dependents');
            for (const input of inputs) {
                const importReport = importsReport[input.filepath];
                if (!importReport) {
                    log.debug(`Could not find the import report for ${input.name}.`);
                    continue;
                }

                for (const dependency of importReport.dependencies) {
                    const foundInput = reportInputsIndexed[dependency];
                    if (!foundInput) {
                        log.debug(
                            `Could not find input for dependency ${cleanName(context, dependency)} of ${input.name}`,
                        );
                        continue;
                    }
                    input.dependencies.add(foundInput);
                }

                for (const dependent of importReport.dependents) {
                    const foundInput = reportInputsIndexed[dependent];
                    if (!foundInput) {
                        log.debug(
                            `Could not find input for dependent ${cleanName(context, dependent)} of ${input.name}`,
                        );
                        continue;
                    }
                    input.dependents.add(foundInput);
                }
            }
            depsEnd();

            // Fill in sourcemaps' inputs if necessary
            if (tempSourcemaps.length) {
                const sourcemapsEnd = log.time('filling sourcemaps inputs');
                for (const sourcemap of tempSourcemaps) {
                    const outputPath = sourcemap.filepath.replace(/\.map$/, '');
                    const foundOutput = reportOutputsIndexed[outputPath];

                    if (!foundOutput) {
                        log.debug(`Could not find output for sourcemap ${sourcemap.name}`);
                        continue;
                    }

                    sourcemap.inputs.push(foundOutput);
                }
                sourcemapsEnd();
            }

            // Gather all outputs from a filepath, following imports.
            const getAllOutputs = (filepath: string, allOutputs: Record<string, Output> = {}) => {
                // We already processed it.
                if (allOutputs[filepath]) {
                    return allOutputs;
                }
                const filename = cleanName(context, filepath);

                // Get its output.
                const foundOutput = reportOutputsIndexed[filepath];
                if (!foundOutput) {
                    log.debug(`Could not find output for ${filename}`);
                    return allOutputs;
                }
                allOutputs[filepath] = foundOutput;

                const asset = bundle[filename];
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
                    getAllOutputs(getAbsolutePath(context.bundler.outDir, importName), allOutputs);
                }

                return allOutputs;
            };

            // Fill in entries
            const entriesEnd = log.time('filling entries');
            for (const entryFile of tempEntryFiles) {
                const entryOutputs = getAllOutputs(entryFile.filepath);
                entryFile.outputs = Object.values(entryOutputs);

                // NOTE: This might not be as accurate as expected, some inputs could be side-effects.
                // Rollup doesn't provide a way to get the imports of an input.
                entryFile.inputs = Array.from(
                    new Set(entryFile.outputs.flatMap((output) => output.inputs)),
                );
                entryFile.size = entryFile.outputs.reduce((acc, output) => acc + output.size, 0);
                entries.push(entryFile);
            }
            entriesEnd();

            context.build.inputs = inputs;
            context.build.outputs = outputs;
            context.build.entries = entries;
            buildReportEnd();
        },
    };
};
