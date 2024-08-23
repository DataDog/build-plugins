import path from 'path';
import type { UnpluginOptions } from 'unplugin';

import type { Logger } from '../../log';
import type { Entry, File, GlobalContext, Output } from '../../types';

import { cleanName, getType } from './helpers';

export const getEsbuildPlugin = (
    context: GlobalContext,
    log: Logger,
): UnpluginOptions['esbuild'] => {
    return {
        setup(build) {
            const cwd = context.cwd;

            // Store entry names based on the configuration.
            const entrypoints = build.initialOptions.entryPoints;
            const entryNames = new Map();
            if (Array.isArray(entrypoints)) {
                // We don't have an indexed object as entry, so we can't get an entry name from it.
                for (const entry of entrypoints) {
                    const fullPath = entry && typeof entry === 'object' ? entry.in : entry;
                    const realEntry = cleanName(context, fullPath);
                    entryNames.set(realEntry, realEntry);
                }
            } else if (entrypoints) {
                const entryList = entrypoints ? Object.entries(entrypoints) : [];
                for (const [entryName, entryPath] of entryList) {
                    entryNames.set(cleanName(context, entryPath), entryName);
                }
            }

            build.onEnd((result) => {
                if (!result.metafile) {
                    const warning = 'Missing metafile from build result.';
                    log(warning, 'warn');
                    context.build.warnings.push(warning);
                    return;
                }

                context.build.errors = result.errors.map((err) => err.text);
                context.build.warnings = result.warnings.map((err) => err.text);

                const inputs: File[] = [];
                const outputs: Output[] = [];
                const tempEntryFiles: Entry[] = [];
                const tempSourcemaps: Output[] = [];
                const entries: Entry[] = [];

                // Loop through inputs.
                for (const [filename, input] of Object.entries(result.metafile.inputs)) {
                    const file: File = {
                        name: cleanName(context, filename),
                        filepath: path.join(cwd, filename),
                        size: input.bytes,
                        type: getType(filename),
                    };

                    inputs.push(file);
                }

                // Loop through outputs.
                for (const [filename, output] of Object.entries(result.metafile.outputs)) {
                    const fullPath = path.join(cwd, filename);
                    const cleanedName = cleanName(context, fullPath);
                    // Get inputs of this output.
                    const inputFiles: File[] = [];
                    for (const inputName of Object.keys(output.inputs)) {
                        const inputFound = inputs.find(
                            (input) => input.filepath === path.join(cwd, inputName),
                        );
                        if (!inputFound) {
                            log(`Input ${inputName} not found for output ${cleanedName}`, 'warn');
                            continue;
                        }

                        inputFiles.push(inputFound);
                    }

                    // When splitting, esbuild creates an empty entryPoint wrapper for the chunk.
                    // It has no inputs, but still relates to its entryPoint.
                    if (output.entryPoint && !inputFiles.length) {
                        const inputFound = inputs.find(
                            (input) => input.filepath === path.join(cwd, output.entryPoint!),
                        );
                        if (!inputFound) {
                            log(
                                `Input ${output.entryPoint} not found for output ${cleanedName}`,
                                'warn',
                            );
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

                    // Store sourcemaps for later filling.
                    if (cleanedName.endsWith('.map')) {
                        tempSourcemaps.push(file);
                    }

                    outputs.push(file);

                    if (!output.entryPoint) {
                        continue;
                    }

                    const inputFile = inputs.find((input) => input.name === output.entryPoint);

                    if (inputFile) {
                        // In the case of "splitting: true", all the files are considered entries to esbuild.
                        // Not to us.
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
                    const outputName = sourcemap.name.replace(/\.map$/, '');
                    const foundOutput = outputs.find((output) => output.name === outputName);

                    if (foundOutput) {
                        sourcemap.inputs.push(foundOutput);
                        continue;
                    }

                    log(`Could not find output for sourcemap ${sourcemap.name}`, 'warn');
                }

                // Re-index metafile data for easier access.
                const reIndex = <T>(obj: Record<string, T>) =>
                    Object.fromEntries(
                        Object.entries(obj).map(([key, value]) => {
                            const newKey = path.join(cwd, key);
                            return [newKey, value];
                        }),
                    );

                // Build our references for the entries.
                const references = {
                    inputs: {
                        report: inputs,
                        // Re-index inputs for easier access.
                        indexed: reIndex(result.metafile.inputs),
                    },
                    outputs: {
                        report: outputs,
                        indexed: reIndex(result.metafile.outputs),
                    },
                };

                // Go through all imports.
                const getAllImports = <T extends File | Output>(
                    filePath: string,
                    ref: typeof references.inputs | typeof references.outputs,
                    allImports: Record<string, T> = {},
                ): Record<string, T> => {
                    const file = ref.report.find(
                        (reportFile: File | Output) => reportFile.filepath === filePath,
                    );
                    if (!file) {
                        log(`Could not find report's ${filePath}`, 'warn');
                        return allImports;
                    }

                    // Check if we already have processed it.
                    if (allImports[filePath]) {
                        return allImports;
                    }

                    allImports[file.filepath] = file as T;

                    const metaFile = ref.indexed[filePath];
                    if (!metaFile) {
                        log(`Could not find metafile's ${filePath}`, 'warn');
                        return allImports;
                    }

                    // If there are no imports, we can return what we have.
                    if (!metaFile.imports || !metaFile.imports.length) {
                        return allImports;
                    }

                    for (const imported of metaFile.imports) {
                        const importPath = path.join(cwd, imported.path);
                        // Look for the other inputs.
                        getAllImports<T>(importPath, ref, allImports);
                    }

                    return allImports;
                };

                // Loop through entries.
                for (const entryFile of tempEntryFiles) {
                    const entryInputs: Record<string, File> = {};
                    const entryOutputs: Record<string, Output> = {};

                    // Do inputs for this entry.
                    for (const input of entryFile.inputs) {
                        getAllImports<File>(input.filepath, references.inputs, entryInputs);
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

                context.build.outputs = outputs;
                context.build.inputs = inputs;
                context.build.entries = entries;
            });
        },
    };
};
