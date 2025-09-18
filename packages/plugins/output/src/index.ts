// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputJson } from '@dd/core/helpers/fs';
import { serializeBuildReport } from '@dd/core/helpers/plugins';
import type { GetPlugins, Logger, PluginOptions } from '@dd/core/types';
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
    (
        log: Logger,
        write: (getStats: () => any) => void,
    ): PluginOptions['webpack'] & PluginOptions['rspack'] =>
    (compiler) => {
        type Stats = Parameters<Parameters<typeof compiler.hooks.done.tap>[1]>[0];
        compiler.hooks.done.tap('bundler-outputs', (stats: Stats) => {
            write(() => {
                const statsTimer = log.time('stats serialization');
                const statsJson = stats.toJson({
                    all: false,
                    assets: true,
                    children: true,
                    chunks: true,
                    chunkGroupAuxiliary: true,
                    chunkGroupChildren: true,
                    chunkGroups: true,
                    chunkRelations: true,
                    entrypoints: true,
                    errors: true,
                    ids: true,
                    modules: true,
                    nestedModules: true,
                    relatedAssets: true,
                    warnings: true,
                    // These two add a massive amount of time to the serialization on big builds.
                    reasons: false,
                    chunkModules: false,
                });
                statsTimer.end();
                return statsJson;
            });
        });
    };

const getRollupPlugin = (
    write: (getOutputs: () => OutputBundle[]) => void,
): PluginOptions['rollup'] & PluginOptions['vite'] => {
    const outputs: Set<OutputBundle> = new Set();
    return {
        buildStart() {
            // Clear set on build start.
            outputs.clear();
        },
        writeBundle(opts, bundle) {
            outputs.add(bundle);
        },
        closeBundle() {
            write(() => Array.from(outputs));
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
    const log = context.getLogger(PLUGIN_NAME);

    // If the plugin is not enabled, return an empty array.
    if (!validatedOptions.enable) {
        return [];
    }

    const writeFile = (name: FileKey, data: any) => {
        const fileValue: FileValue = validatedOptions.files[name];
        if (!data || fileValue === false) {
            return;
        }

        const queuedWrite = async () => {
            const timeWrite = log.time(`output ${fileValue}`);
            const filePath = getFilePath(context.bundler.outDir, validatedOptions.path, fileValue);
            let error: unknown;

            try {
                const dataToWrite = typeof data === 'function' ? await data() : data;
                await outputJson(filePath, dataToWrite);
            } catch (e) {
                error = e;
            }

            if (error) {
                log.error(`Failed writing ${fileValue}: ${error}`);
            } else {
                log.info(`Wrote "${filePath}"`);
            }

            timeWrite.end();
        };
        // Do not make the file creations blocking.
        context.queue(queuedWrite());
    };

    return [
        {
            name: PLUGIN_NAME,
            buildReport(report) {
                const timeSerialization = log.time(`serialize report`);
                const serializedReport = serializeBuildReport(report);
                timeSerialization.end();
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
                writeFile('metrics', () => Array.from(metrics));
            },
            esbuild: {
                setup(build) {
                    build.onEnd((result) => {
                        writeFile('bundler', result.metafile);
                    });
                },
            },
            rspack: getXpackPlugin(log, (getStats) => {
                writeFile('bundler', getStats);
            }),
            rollup: getRollupPlugin((getOutputs) => {
                writeFile('bundler', getOutputs);
            }),
            vite: getRollupPlugin((getOutputs) => {
                writeFile('bundler', getOutputs);
            }),
            webpack: getXpackPlugin(log, (getStats) => {
                writeFile('bundler', getStats);
            }),
        },
    ];
};
