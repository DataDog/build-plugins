import { writeFileSync } from 'fs';
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
                const tempEntryFiles: [Entry, any][] = [];
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
                    const inputFiles = [];
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
                            // Compute this
                            outputs: [file],
                            // Compute this
                            size: file.size,
                        };

                        tempEntryFiles.push([entry, output]);
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

                // Loop through entries.
                for (const [entryFile, asset] of tempEntryFiles) {
                    // If it imports other outputs we add them to it.
                    for (const importedAsset of asset.imports) {
                        const module = outputs.find((output) => output.name === importedAsset.path);

                        if (module) {
                            entryFile.outputs.push(module);
                            entryFile.inputs.push(...module.inputs);
                            entryFile.size += module.size;
                        }
                    }

                    entries.push(entryFile);
                }

                context.build.outputs = outputs;
                context.build.inputs = inputs;
                context.build.entries = entries;

                writeFileSync('report.esbuild.json', JSON.stringify(context.build, null, 4));
                writeFileSync('output.esbuild.json', JSON.stringify(result, null, 4));

                console.log('END CONTEXT', context.bundler.fullName);
            });
        },
    };
};
