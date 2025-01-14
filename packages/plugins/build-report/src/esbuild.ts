// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getEsbuildEntries, isInjectionFile } from '@dd/core/helpers';
import type {
    Logger,
    Entry,
    GlobalContext,
    Input,
    Output,
    PluginOptions,
    ResolvedEntry,
} from '@dd/core/types';

import { cleanName, getAbsolutePath, getType } from './helpers';

// Re-index metafile data for easier access.
const reIndexMeta = <T>(obj: Record<string, T>, cwd: string) =>
    Object.fromEntries(
        Object.entries(obj).map(([key, value]) => {
            const newKey = getAbsolutePath(cwd, key);
            return [newKey, value];
        }),
    );

export const getEsbuildPlugin = (context: GlobalContext, log: Logger): PluginOptions['esbuild'] => {
    return {
        setup(build) {
            const cwd = context.cwd;
            const entryNames = new Map();
            const resolvedEntries: ResolvedEntry[] = [];

            build.onStart(async () => {
                // Store entry names based on the configuration.
                resolvedEntries.push(...(await getEsbuildEntries(build, context, log)));
                for (const entry of resolvedEntries) {
                    const cleanedName = cleanName(context, entry.resolved);
                    if (entry.name) {
                        entryNames.set(cleanedName, entry.name);
                    } else {
                        entryNames.set(cleanedName, cleanedName);
                    }
                }
            });

            build.onEnd((result) => {
                for (const error of result.errors) {
                    context.build.errors.push(error.text);
                }
                for (const warning of result.warnings) {
                    context.build.warnings.push(warning.text);
                }

                const warn = (warning: string) => {
                    context.build.warnings.push(warning);
                    log.warn(warning);
                };

                if (!result.metafile) {
                    warn('Missing metafile from build result.');
                    return;
                }

                const inputs: Input[] = [];
                const outputs: Output[] = [];
                const tempEntryFiles: Entry[] = [];
                const tempSourcemaps: Output[] = [];
                const entries: Entry[] = [];

                const reportInputsIndexed: Record<string, Input> = {};
                const reportOutputsIndexed: Record<string, Output> = {};

                const metaInputsIndexed = reIndexMeta(result.metafile.inputs, cwd);
                const metaOutputsIndexed = reIndexMeta(result.metafile.outputs, cwd);

                // From a proxy entry point, created by our injection plugin, get the real path.
                const getRealPathFromInjectionProxy = (entryPoint: string): string => {
                    if (!isInjectionFile(entryPoint)) {
                        return entryPoint;
                    }

                    const metaInput = metaInputsIndexed[getAbsolutePath(cwd, entryPoint)];
                    if (!metaInput) {
                        return entryPoint;
                    }

                    // Get the first non-injection import.
                    const actualImport = metaInput.imports.find(
                        (imp) => !isInjectionFile(imp.path),
                    );
                    if (!actualImport) {
                        return entryPoint;
                    }

                    return actualImport.path;
                };

                // Loop through inputs.
                for (const [filename, input] of Object.entries(result.metafile.inputs)) {
                    if (isInjectionFile(filename)) {
                        continue;
                    }

                    const filepath = getAbsolutePath(cwd, filename);
                    const name = cleanName(context, filename);

                    const file: Input = {
                        name,
                        filepath,
                        dependents: new Set(),
                        dependencies: new Set(),
                        size: input.bytes,
                        type: getType(filename),
                    };
                    reportInputsIndexed[filepath] = file;
                    inputs.push(file);
                }

                // Loop through outputs.
                for (const [filename, output] of Object.entries(result.metafile.outputs)) {
                    const fullPath = getAbsolutePath(cwd, filename);
                    const cleanedName = cleanName(context, fullPath);
                    // Get inputs of this output.
                    const inputFiles: Input[] = [];
                    for (const inputName of Object.keys(output.inputs)) {
                        if (isInjectionFile(inputName)) {
                            continue;
                        }

                        const inputFound = reportInputsIndexed[getAbsolutePath(cwd, inputName)];
                        if (!inputFound) {
                            warn(`Input ${inputName} not found for output ${cleanedName}`);
                            continue;
                        }

                        inputFiles.push(inputFound);
                    }

                    // When splitting, esbuild creates an empty entryPoint wrapper for the chunk.
                    // It has no inputs, but still relates to its entryPoint.
                    if (output.entryPoint && !inputFiles.length) {
                        const inputFound =
                            reportInputsIndexed[getAbsolutePath(cwd, output.entryPoint!)];
                        if (!inputFound) {
                            warn(`Input ${output.entryPoint} not found for output ${cleanedName}`);
                            continue;
                        }
                        inputFiles.push(inputFound);
                    }

                    const file: Output = {
                        name: cleanedName,
                        filepath: fullPath,
                        inputs: inputFiles,
                        size: output.bytes,
                        type: getType(fullPath),
                    };

                    reportOutputsIndexed[fullPath] = file;

                    // Store sourcemaps for later filling.
                    if (file.type === 'map') {
                        tempSourcemaps.push(file);
                    }

                    outputs.push(file);

                    if (!output.entryPoint) {
                        continue;
                    }

                    // The entryPoint may have been altered by our injection plugin.
                    const inputFile =
                        reportInputsIndexed[
                            getAbsolutePath(cwd, getRealPathFromInjectionProxy(output.entryPoint))
                        ];

                    if (inputFile) {
                        // In the case of "splitting: true", all the files are considered entries to esbuild.
                        // Not to us.
                        // Verify we have listed it as an entry earlier.
                        if (!entryNames.get(inputFile.name)) {
                            continue;
                        }

                        const entry = {
                            ...file,
                            name: entryNames.get(inputFile.name) || inputFile.name,
                            outputs: [file],
                            size: file.size,
                        };

                        tempEntryFiles.push(entry);
                    }
                }

                // Loop through sourcemaps.
                for (const sourcemap of tempSourcemaps) {
                    const outputFilepath = sourcemap.filepath.replace(/\.map$/, '');
                    const foundOutput = reportOutputsIndexed[outputFilepath];

                    if (!foundOutput) {
                        warn(`Could not find output for sourcemap ${sourcemap.name}`);
                        continue;
                    }

                    sourcemap.inputs.push(foundOutput);
                }

                // Build our references for the entries.
                const references = {
                    inputs: {
                        report: reportInputsIndexed,
                        meta: metaInputsIndexed,
                    },
                    outputs: {
                        report: reportOutputsIndexed,
                        meta: metaOutputsIndexed,
                    },
                };

                // There are some exceptions we want to ignore.
                const FILE_EXCEPTIONS_RX = /(<runtime>|https:|file:|data:|#)/g;
                const isFileSupported = (filePath: string) => {
                    if (isInjectionFile(filePath) || filePath.match(FILE_EXCEPTIONS_RX)) {
                        return false;
                    }
                    return true;
                };

                // Go through all imports.
                const getAllImports = <T extends Input | Output>(
                    filePath: string,
                    ref: typeof references.inputs | typeof references.outputs,
                    allImports: Record<string, T> = {},
                ): Record<string, T> => {
                    if (!isFileSupported(filePath)) {
                        return allImports;
                    }

                    const file = ref.report[filePath];
                    if (!file) {
                        warn(`Could not find report's ${filePath}`);
                        return allImports;
                    }

                    // Check if we already have processed it.
                    if (allImports[file.filepath]) {
                        return allImports;
                    }

                    allImports[file.filepath] = file as T;

                    const metaFile = ref.meta[filePath];
                    if (!metaFile) {
                        warn(`Could not find metafile's ${filePath}`);
                        return allImports;
                    }

                    // If there are no imports, we can return what we have.
                    if (!metaFile.imports || !metaFile.imports.length) {
                        return allImports;
                    }

                    for (const imported of metaFile.imports) {
                        const importPath = getAbsolutePath(cwd, imported.path);
                        // Look for the other inputs.
                        getAllImports<T>(importPath, ref, allImports);
                    }

                    return allImports;
                };

                // Loop through entries.
                // TODO This is slightly underperformant due to getAllImports' recursivity.
                for (const entryFile of tempEntryFiles) {
                    const entryInputs: Record<string, Input> = {};
                    const entryOutputs: Record<string, Output> = {};

                    // Do inputs for this entry.
                    for (const input of entryFile.inputs) {
                        getAllImports<Input>(input.filepath, references.inputs, entryInputs);
                    }

                    // Do outputs for this entry.
                    for (const outputFile of entryFile.outputs) {
                        getAllImports<Output>(
                            outputFile.filepath,
                            references.outputs,
                            entryOutputs,
                        );
                    }

                    entryFile.inputs = Object.values(entryInputs);
                    entryFile.outputs = Object.values(entryOutputs);
                    entryFile.size = entryFile.outputs.reduce(
                        (acc, output) => acc + output.size,
                        0,
                    );

                    entries.push(entryFile);
                }

                // Loop through all inputs to aggregate dependencies and dependents.
                for (const input of inputs) {
                    const metaFile = references.inputs.meta[input.filepath];
                    if (!metaFile) {
                        warn(`Could not find metafile's ${input.name}`);
                        continue;
                    }

                    for (const dependency of metaFile.imports) {
                        if (!isFileSupported(dependency.path)) {
                            continue;
                        }
                        const dependencyPath = getAbsolutePath(cwd, dependency.path);
                        const dependencyFile = references.inputs.report[dependencyPath];

                        if (!dependencyFile) {
                            warn(`Could not find input file of ${dependency.path}`);
                            continue;
                        }

                        input.dependencies.add(dependencyFile);
                        // Add itself to the dependency's dependents.
                        dependencyFile.dependents.add(input);
                    }
                }

                context.build.outputs = outputs;
                context.build.inputs = inputs;
                context.build.entries = entries;
            });
        },
    };
};
