// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { writeFileSync } from 'fs';
import path from 'path';
import type { UnpluginOptions } from 'unplugin';

import type { Logger } from '../../log';
import type { Entry, GlobalContext, Input, Output } from '../../types';

import { cleanName, cleanPath, getType, serializeBuildReport } from './helpers';

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

            report.dependencies.push(...info.dynamicallyImportedIds, ...info.importedIds);
            report.dependents.push(...info.dynamicImporters, ...info.importers);

            importsReport[cleanId] = report;
        },
        writeBundle(options, bundle) {
            const inputs: Input[] = [];
            const outputs: Output[] = [];
            const tempEntryFiles: Entry[] = [];
            const tempSourcemaps: Output[] = [];
            const entries: Entry[] = [];

            const cleanReport = (report: string[], filepath: string) => {
                console.log('Cleaning report', filepath, report, report.map(cleanPath));
                return Array.from(new Set(report.map(cleanPath))).filter(
                    (reportFilepath) =>
                        reportFilepath !== filepath && reportFilepath !== 'commonjsHelpers.js',
                );
            };

            // Complete the importsReport with missing dependents.
            for (const [filepath, { dependencies, dependents }] of Object.entries(importsReport)) {
                for (const dependency of dependencies) {
                    const cleanedDependency = cleanPath(dependency);
                    if (!importsReport[cleanedDependency]) {
                        importsReport[cleanedDependency] = { dependencies: [], dependents: [] };
                    }

                    if (
                        !importsReport[cleanedDependency].dependents.length ||
                        !importsReport[cleanedDependency].dependents.includes(filepath)
                    ) {
                        importsReport[cleanedDependency].dependents.push(filepath);
                    }
                }

                for (const dependent of dependents) {
                    const cleanedDependent = cleanPath(dependent);
                    if (!importsReport[cleanedDependent]) {
                        importsReport[cleanedDependent] = { dependencies: [], dependents: [] };
                    }

                    if (
                        !importsReport[cleanedDependent].dependencies.length ||
                        !importsReport[cleanedDependent].dependencies.includes(filepath)
                    ) {
                        importsReport[cleanedDependent].dependencies.push(filepath);
                    }
                }
            }

            writeFileSync(
                `output.${context.bundler.fullName}.json`,
                JSON.stringify(bundle, null, 2),
            );

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
                    }
                }

                // Store entries for later filling.
                // As we may not have reported its outputs and inputs yet.
                if ('isEntry' in asset && asset.isEntry) {
                    tempEntryFiles.push({ ...file, name: asset.name, size: 0, outputs: [file] });
                }

                outputs.push(file);
                if (file.type !== 'map') {
                    // We know it's not a map, so we cast its inputs.
                    inputs.push(...(file.inputs as Input[]));
                }
            }

            const getAll = (
                attribute: 'dependents' | 'dependencies',
                filepath: string,
                accumulator: string[] = [],
            ): string[] => {
                const reported: string[] = importsReport[filepath]?.[attribute] || [];
                for (const reportedFilename of reported) {
                    if (accumulator.includes(reportedFilename)) {
                        continue;
                    }

                    accumulator.push(reportedFilename);
                    getAll(attribute, reportedFilename, accumulator);
                }
                return accumulator;
            };

            // Fill in inputs' dependencies and dependents.
            for (const input of inputs) {
                const dependencies = cleanReport(
                    getAll('dependencies', input.filepath),
                    input.filepath,
                );
                const dependents = cleanReport(
                    getAll('dependents', input.filepath),
                    input.filepath,
                );

                console.log(
                    'Diff dependencies',
                    input.name,
                    dependencies.length,
                    getAll('dependencies', input.filepath).length,
                    input.dependencies.length,
                    importsReport[input.filepath]?.dependencies.length,
                    importsReport[input.filepath]?.dependencies,
                );

                console.log(
                    'Diff dependents',
                    input.name,
                    dependents.length,
                    getAll('dependents', input.filepath).length,
                    input.dependents.length,
                    importsReport[input.filepath]?.dependents.length,
                    importsReport[input.filepath]?.dependents,
                );

                for (const dependency of dependencies) {
                    const foundInput = inputs.find((i) => i.filepath === dependency);
                    if (!foundInput) {
                        log(
                            `Could not find input for dependency ${cleanName(context, dependency)} of ${input.name}`,
                            'warn',
                        );
                        continue;
                    }
                    input.dependencies.push(foundInput);
                }

                for (const dependent of dependents) {
                    const foundInput = inputs.find((i) => i.filepath === dependent);
                    if (!foundInput) {
                        log(
                            `Could not find input for dependent ${cleanName(context, dependent)} of ${input.name}`,
                            'warn',
                        );
                        continue;
                    }
                    input.dependents.push(foundInput);
                }
            }

            // Fill in sourcemaps' inputs
            for (const sourcemap of tempSourcemaps) {
                const outputName = sourcemap.name.replace(/\.map$/, '');
                const foundOutput = outputs.find((output) => output.name === outputName);

                if (!foundOutput) {
                    log(`Could not find output for sourcemap ${sourcemap.name}`, 'warn');
                    continue;
                }

                sourcemap.inputs.push(foundOutput);
            }

            // Gather all outputs from a filepath, following imports.
            const getAllOutputs = (filepath: string, allOutputs: Record<string, Output>) => {
                // We already processed it.
                if (allOutputs[filepath]) {
                    return allOutputs;
                }
                const filename = cleanName(context, filepath);

                // Get its output.
                const foundOutput = outputs.find((output) => output.filepath === filepath);
                if (!foundOutput) {
                    log(`Could not find output for ${filename}`, 'warn');
                    return allOutputs;
                }
                allOutputs[filepath] = foundOutput;

                const asset = bundle[filename];
                if (!asset) {
                    log(`Could not find asset for ${filename}`, 'warn');
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
                const entryOutputs: Record<string, Output> = {};
                getAllOutputs(entryFile.filepath, entryOutputs);
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

            writeFileSync(
                `report.${context.bundler.fullName}.json`,
                JSON.stringify(serializeBuildReport(context.build), null, 2),
            );
        },
    };
};
