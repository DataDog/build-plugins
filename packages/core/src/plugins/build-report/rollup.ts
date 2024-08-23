import path from 'path';
import type { UnpluginOptions } from 'unplugin';

import type { Logger } from '../../log';
import type { Entry, File, GlobalContext, Output } from '../../types';

import { cleanName, getType } from './helpers';

export const getRollupPlugin = (
    context: GlobalContext,
    log: Logger,
): UnpluginOptions['rollup'] => ({
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
    writeBundle(options, bundle) {
        const inputs: File[] = [];
        const outputs: Output[] = [];
        const tempEntryFiles: Entry[] = [];
        const tempSourcemaps: Output[] = [];
        const entries: Entry[] = [];

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
                    const moduleFile: File = {
                        name: cleanName(context, modulepath),
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
            inputs.push(...file.inputs);
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
    },
});
