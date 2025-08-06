// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputJsonSync } from '@dd/core/helpers/fs';
import { serializeBuildReport } from '@dd/core/helpers/plugins';
import type { GetPlugins, PluginOptions } from '@dd/core/types';
import path from 'path';
import type { OutputBundle } from 'rollup';

import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import type { FileKey, FileValue, OutputOptions } from './types';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME };

export const helpers = {
    // Add the helpers you'd like to expose here.
};

export type types = {
    // Add the types you'd like to expose here.
    OutputOptions: OutputOptions;
};

const getXpackPlugin =
    (write: (stats: any) => void): PluginOptions['webpack'] & PluginOptions['rspack'] =>
    (compiler) => {
        type Stats = Parameters<Parameters<typeof compiler.hooks.done.tap>[1]>[0];
        compiler.hooks.done.tap('bundler-outputs', (stats: Stats) => {
            const statsJson = stats.toJson({
                all: false,
                assets: true,
                children: true,
                chunks: true,
                chunkGroupAuxiliary: true,
                chunkGroupChildren: true,
                chunkGroups: true,
                chunkModules: true,
                chunkRelations: true,
                entrypoints: true,
                errors: true,
                ids: true,
                modules: true,
                nestedModules: true,
                reasons: true,
                relatedAssets: true,
                warnings: true,
            });

            write(statsJson);
        });
    };

const getRollupPlugin = (
    write: (outputs: OutputBundle[]) => void,
): PluginOptions['rollup'] & PluginOptions['vite'] => {
    const outputs: OutputBundle[] = [];
    return {
        writeBundle(opts, bundle) {
            outputs.push(bundle);
        },
        closeBundle() {
            write(outputs);
        },
    };
};

export const getFilePath = (outDir: string, pathOption: string, filename: string): string => {
    // If we have an absolute path, we use it as is.
    const outputPath = path.isAbsolute(pathOption)
        ? pathOption
        : // Otherwise, we resolve it relative to the bundler output directory.
          path.resolve(outDir, pathOption);
    return path.resolve(outputPath, filename);
};

export const getPlugins: GetPlugins = ({ options, context }) => {
    // Verify configuration.
    const validatedOptions = validateOptions(options);

    // If the plugin is not enabled, return an empty array.
    if (!validatedOptions.enable) {
        return [];
    }

    const writeFile = (name: FileKey, data: any) => {
        const fileValue: FileValue = validatedOptions.files[name];
        if (data && fileValue !== false) {
            outputJsonSync(
                getFilePath(context.bundler.outDir, validatedOptions.path, fileValue),
                data,
            );
        }
    };

    return [
        {
            name: PLUGIN_NAME,
            buildReport(report) {
                const serializedReport = serializeBuildReport(report);
                writeFile('build', {
                    bundler: serializedReport.bundler,
                    metadata: serializedReport.metadata,
                    start: serializedReport.start,
                    end: serializedReport.end,
                    duration: serializedReport.duration,
                    writeDuration: serializedReport.writeDuration,
                    entries: serializedReport.entries,
                    outputs: serializedReport.outputs,
                });
                writeFile('logs', serializedReport.logs);
                writeFile('timings', serializedReport.timings);
                writeFile('dependencies', serializedReport.inputs);
                writeFile('errors', serializedReport.errors);
                writeFile('warnings', serializedReport.warnings);
            },
            metrics(metrics) {
                writeFile('metrics', Array.from(metrics));
            },
            esbuild: {
                setup(build) {
                    build.onEnd((result) => {
                        writeFile('bundler', result.metafile);
                    });
                },
            },
            rspack: getXpackPlugin((stats) => {
                writeFile('bundler', stats);
            }),
            rollup: getRollupPlugin((outputs) => {
                writeFile('bundler', outputs);
            }),
            vite: getRollupPlugin((outputs) => {
                writeFile('bundler', outputs);
            }),
            webpack: getXpackPlugin((stats) => {
                writeFile('bundler', stats);
            }),
        },
    ];
};
