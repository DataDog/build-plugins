// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import { outputJsonSync } from '@dd/core/helpers/fs';
import type {
    BuildReport,
    Entry,
    FileReport,
    GetCustomPlugins,
    GlobalContext,
    Input,
    IterableElement,
    Options,
    Output,
    SerializedBuildReport,
    SerializedEntry,
    SerializedInput,
    SerializedOutput,
} from '@dd/core/types';
import path from 'path';
import type { OutputBundle } from 'rollup';

export const cleanPluginName = (name: string) => {
    // Will remove the "@dd/", "@dd/datadog-", "@dd/internal-", "datadog-" prefixes and the "-plugin" suffix.
    return name.replace(/^@dd\/(datadog-|internal-)?|^datadog-|-plugin$/g, '');
};

// Is the file coming from the injection plugin?
export const isInjectionFile = (filename: string) => filename.includes(INJECTED_FILE);

// Returns an object that is safe to serialize to JSON.
// Mostly useful for debugging and testing.
export const serializeBuildReport = (report: BuildReport): SerializedBuildReport => {
    // Report is an object that self reference some of its values.
    // To make it JSON serializable, we need to remove the self references
    // and replace them with strings, we'll use "filepath" to still have them uniquely identifiable.
    const jsonReport: SerializedBuildReport = {
        bundler: report.bundler,
        errors: report.errors,
        metadata: report.metadata,
        warnings: report.warnings,
        logs: report.logs,
        timings: report.timings,
        start: report.start,
        end: report.end,
        duration: report.duration,
        writeDuration: report.writeDuration,
        entries: [],
        inputs: [],
        outputs: [],
    };

    for (const entry of report.entries || []) {
        const newEntry: SerializedEntry = { ...entry, inputs: [], outputs: [] };
        if (entry.inputs) {
            newEntry.inputs = entry.inputs.map((file: FileReport) => file.filepath);
        }
        if (entry.outputs) {
            newEntry.outputs = entry.outputs.map((file: FileReport) => file.filepath);
        }
        jsonReport.entries.push(newEntry);
    }

    for (const input of report.inputs || []) {
        const newInput: SerializedInput = { ...input, dependencies: [], dependents: [] };
        if (input.dependencies) {
            for (const dependency of input.dependencies) {
                newInput.dependencies.push(dependency.filepath);
            }
        }
        if (input.dependents) {
            for (const dependent of input.dependents) {
                newInput.dependents.push(dependent.filepath);
            }
        }
        jsonReport.inputs.push(newInput);
    }

    for (const output of report.outputs || []) {
        const newOutput: SerializedOutput = { ...output, inputs: [] };
        if (output.inputs) {
            newOutput.inputs = output.inputs.map((file: FileReport) => file.filepath);
        }
        jsonReport.outputs.push(newOutput);
    }

    return jsonReport;
};

// Returns an object that is unserialized from serializeBuildReport().
// Mostly useful for debugging and testing.
export const unserializeBuildReport = (report: SerializedBuildReport): BuildReport => {
    const buildReport: BuildReport = {
        bundler: report.bundler,
        errors: report.errors,
        metadata: report.metadata,
        warnings: report.warnings,
        logs: report.logs,
        timings: report.timings,
        start: report.start,
        end: report.end,
        duration: report.duration,
        writeDuration: report.writeDuration,
    };

    const reportInputs = report.inputs || [];
    const reportOutputs = report.outputs || [];

    const entries: Entry[] = [];

    // Prefill inputs and outputs as they are sometimes self-referencing themselves.
    const indexedInputs: Map<string, Input> = new Map();
    const inputs: Input[] = reportInputs.map<Input>((input) => {
        const newInput: Input = {
            ...input,
            // Keep them empty for now, we'll fill them later.
            dependencies: new Set(),
            dependents: new Set(),
        };
        indexedInputs.set(input.filepath, newInput);
        return newInput;
    });

    const indexedOutputs: Map<string, Output> = new Map();
    const outputs: Output[] = reportOutputs.map<Output>((output) => {
        const newOutput: Output = { ...output, inputs: [] };
        indexedOutputs.set(output.filepath, newOutput);
        return newOutput;
    });

    // Fill in the inputs' dependencies and dependents.
    for (const input of reportInputs) {
        const newInput: Input = indexedInputs.get(input.filepath)!;

        // Re-assign the dependencies and dependents to the actual objects.
        if (input.dependencies) {
            for (const dependency of input.dependencies) {
                const newDependency = indexedInputs.get(dependency)!;
                newInput.dependencies.add(newDependency);
            }
        }
        if (input.dependents) {
            for (const dependent of input.dependents) {
                const newDependent = indexedInputs.get(dependent)!;
                newInput.dependents.add(newDependent);
            }
        }
    }

    // Fill in the outputs' inputs.
    for (const output of reportOutputs) {
        const newOutput: Output = indexedOutputs.get(output.filepath)!;
        if (output.inputs) {
            // Re-assign the inputs to the actual objects.
            newOutput.inputs = output.inputs
                .map<
                    // Can be either an input or an output (for sourcemaps).
                    Input | Output | undefined
                >((filepath: string) => indexedInputs.get(filepath) || indexedOutputs.get(filepath))
                .filter(Boolean) as (Input | Output)[];
        }
    }

    for (const entry of report.entries || []) {
        const newEntry: Entry = { ...entry, inputs: [], outputs: [] };
        if (entry.inputs) {
            newEntry.inputs = entry.inputs
                .map((filepath: string) => indexedInputs.get(filepath))
                .filter(Boolean) as (Output | Input)[];
        }
        if (entry.outputs) {
            newEntry.outputs = entry.outputs
                .map((filepath: string) => indexedOutputs.get(filepath))
                .filter(Boolean) as Output[];
        }
        entries.push(newEntry);
    }

    return {
        ...buildReport,
        entries,
        inputs,
        outputs,
    };
};

// Returns a customPlugin to output some debug files.
type CustomPlugins = ReturnType<GetCustomPlugins>;
export const debugFilesPlugins = (context: GlobalContext): CustomPlugins => {
    const outputFilePath = () =>
        path.resolve(context.bundler.outDir, `output.${context.bundler.name}.json`);
    const reportFilePath = () =>
        path.resolve(context.bundler.outDir, `report.${context.bundler.name}.json`);
    const xpackPlugin: IterableElement<CustomPlugins>['webpack'] &
        IterableElement<CustomPlugins>['rspack'] = (compiler) => {
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
            outputJsonSync(outputFilePath(), statsJson);
        });
    };

    const viteOutputs: OutputBundle[] = [];
    const rollupOutputs: OutputBundle[] = [];

    return [
        {
            name: 'build-report',
            enforce: 'post',
            buildReport(report) {
                outputJsonSync(reportFilePath(), serializeBuildReport(report));
            },
        },
        {
            name: 'bundler-outputs',
            enforce: 'post',
            esbuild: {
                setup(build) {
                    build.onEnd((result) => {
                        outputJsonSync(outputFilePath(), result.metafile);
                    });
                },
            },
            rspack: xpackPlugin,
            rollup: {
                writeBundle(options, bundle) {
                    rollupOutputs.push(bundle);
                },
                closeBundle() {
                    outputJsonSync(outputFilePath(), rollupOutputs);
                },
            },
            vite: {
                writeBundle(options, bundle) {
                    viteOutputs.push(bundle);
                },
                closeBundle() {
                    outputJsonSync(outputFilePath(), viteOutputs);
                },
            },
            webpack: xpackPlugin,
        },
    ];
};

// Verify that we should get the git information based on the options.
// Only get git information if sourcemaps are enabled and git is not disabled.
export const shouldGetGitInfo = (options: Options): boolean => {
    return (
        !!options.errorTracking?.sourcemaps &&
        options.errorTracking?.sourcemaps.disableGit !== true &&
        options.disableGit !== true
    );
};
