import { writeFileSync } from 'fs';
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
        const tempEntryFiles: [Entry, any][] = [];
        const tempSourcemaps: Output[] = [];
        const entries: Entry[] = [];

        writeFileSync(`output.${context.bundler.fullName}.json`, JSON.stringify(bundle, null, 4));

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
            if (file.type === 'map') {
                tempSourcemaps.push(file);
            }

            if ('modules' in asset) {
                for (const [modulepath, module] of Object.entries(asset.modules)) {
                    const moduleFile: File = {
                        name: cleanName(context, modulepath),
                        filepath: modulepath,
                        // Since we store as entry and inputs, we use the originalLength.
                        size: module.originalLength,
                        type: getType(modulepath),
                    };

                    file.inputs.push(moduleFile);
                }
            }

            if ('isEntry' in asset && asset.isEntry) {
                tempEntryFiles.push([
                    { ...file, name: asset.name, size: 0, outputs: [file] },
                    asset,
                ]);
            }

            outputs.push(file);
            inputs.push(...file.inputs);
        }

        // Fill in sourcemaps' inputs
        for (const sourcemap of tempSourcemaps) {
            const outputName = sourcemap.name.replace(/\.map$/, '');
            const foundOutput = outputs.find((output) => output.name === outputName);
            if (foundOutput) {
                sourcemap.inputs.push(foundOutput);
                continue;
            }

            log(`Could not find output for sourcemap ${sourcemap.name}`, 'warn');
        }

        // Second loop to fill in entries
        for (const [entryFile, asset] of tempEntryFiles) {
            // If it imports other outputs we add them to it.
            for (const outputName of asset.imports) {
                const module = outputs.find((output) => output.name === outputName);
                if (module) {
                    entryFile.outputs.push(module);
                    entryFile.size += module.size;
                }
            }

            entries.push(entryFile);
        }

        context.build.inputs = inputs;
        context.build.outputs = outputs;
        context.build.entries = entries;
        writeFileSync(
            `report.${context.bundler.fullName}.json`,
            JSON.stringify(context.build, null, 4),
        );

        console.log('END CONTEXT', context.bundler.fullName);
    },
});
