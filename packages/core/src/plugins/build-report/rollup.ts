// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';
import type { UnpluginOptions } from 'unplugin';

import type { Logger } from '../../log';
import type { Entry, GlobalContext, Input, Output } from '../../types';

import { cleanName, cleanPath, cleanReport, getType } from './helpers';

export const getRollupPlugin = (context: GlobalContext, log: Logger): UnpluginOptions['rollup'] => {
    const importsReport: Record<
        string,
        {
            dependencies: string[];
            dependents: string[];
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
                dependencies: [],
                dependents: [],
            };

            // Clean new dependencies and dependents.
            const newDependencies = cleanReport(
                [...info.dynamicallyImportedIds, ...info.importedIds],
                cleanId,
            ).filter((dependency) => !report.dependencies.includes(dependency));
            const newDependents = cleanReport(
                [...info.dynamicImporters, ...info.importers],
                cleanId,
            ).filter((dependent) => !report.dependents.includes(dependent));

            report.dependencies.push(...newDependencies);
            report.dependents.push(...newDependents);

            importsReport[cleanId] = report;
        },
        writeBundle(options, bundle) {
            const inputs: Input[] = [];
            const outputs: Output[] = [];
            const tempEntryFiles: Entry[] = [];
            const tempSourcemaps: Output[] = [];
            const entries: Entry[] = [];

            const reportInputsIndexed: Record<string, Input> = {};
            const reportOutputsIndexed: Record<string, Output> = {};

            const warn = (warning: string) => {
                context.build.warnings.push(warning);
                log(warning, 'warn');
            };

            // Complete the importsReport with missing dependents and dependencies.
            for (const [filepath, { dependencies, dependents }] of Object.entries(importsReport)) {
                for (const dependency of dependencies) {
                    const cleanedDependency = cleanPath(dependency);
                    if (!importsReport[cleanedDependency]) {
                        importsReport[cleanedDependency] = { dependencies: [], dependents: [] };
                    }

                    if (importsReport[cleanedDependency].dependents.includes(filepath)) {
                        continue;
                    }

                    importsReport[cleanedDependency].dependents.push(filepath);
                }

                for (const dependent of dependents) {
                    const cleanedDependent = cleanPath(dependent);
                    if (!importsReport[cleanedDependent]) {
                        importsReport[cleanedDependent] = { dependencies: [], dependents: [] };
                    }

                    if (importsReport[cleanedDependent].dependencies.includes(filepath)) {
                        continue;
                    }

                    importsReport[cleanedDependent].dependencies.push(filepath);
                }
            }

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
                            dependencies: [],
                            dependents: [],
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

            // Fill in inputs' dependencies and dependents.
            for (const input of inputs) {
                const importReport = importsReport[input.filepath];
                if (!importReport) {
                    warn(`Could not find the import report for ${input.name}.`);
                    continue;
                }

                for (const dependency of importReport.dependencies) {
                    const foundInput = reportInputsIndexed[dependency];
                    if (!foundInput) {
                        warn(
                            `Could not find input for dependency ${cleanName(context, dependency)} of ${input.name}`,
                        );
                        continue;
                    }
                    input.dependencies.push(foundInput);
                }

                for (const dependent of importReport.dependents) {
                    const foundInput = reportInputsIndexed[dependent];
                    if (!foundInput) {
                        warn(
                            `Could not find input for dependent ${cleanName(context, dependent)} of ${input.name}`,
                        );
                        continue;
                    }
                    input.dependents.push(foundInput);
                }
            }

            // Fill in sourcemaps' inputs if necessary
            if (tempSourcemaps.length) {
                for (const sourcemap of tempSourcemaps) {
                    const outputPath = sourcemap.filepath.replace(/\.map$/, '');
                    const foundOutput = reportOutputsIndexed[outputPath];

                    if (!foundOutput) {
                        warn(`Could not find output for sourcemap ${sourcemap.name}`);
                        continue;
                    }

                    sourcemap.inputs.push(foundOutput);
                }
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
                    warn(`Could not find output for ${filename}`);
                    return allOutputs;
                }
                allOutputs[filepath] = foundOutput;

                const asset = bundle[filename];
                if (!asset) {
                    warn(`Could not find asset for ${filename}`);
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
                    getAllOutputs(path.join(context.bundler.outDir, importName), allOutputs);
                }

                return allOutputs;
            };

            // Fill in entries
            for (const entryFile of tempEntryFiles) {
                const entryOutputs = getAllOutputs(entryFile.filepath);
                entryFile.outputs = Object.values(entryOutputs);

                // NOTE: This might not be as accurate as we want, some inputs could be side-effects.
                // Rollup doesn't provide a way to get the imports of an input.
                entryFile.inputs = Array.from(
                    new Set(entryFile.outputs.flatMap((output) => output.inputs)),
                );
                entryFile.size = entryFile.outputs.reduce((acc, output) => acc + output.size, 0);
                entries.push(entryFile);
            }

            context.build.inputs = inputs;
            context.build.outputs = outputs;
            context.build.entries = entries;
        },
    };
};
