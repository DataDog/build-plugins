// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    BuildReport,
    SerializedEntry,
    File,
    GlobalContext,
    SerializedInput,
    SerializedBuildReport,
    SerializedOutput,
    Entry,
    Input,
    Output,
} from '../../types';

export const getType = (name: string): string => {
    if (name === 'unknown') {
        return name;
    }

    if (name.includes('webpack/runtime')) {
        return 'runtime';
    }

    return name.includes('.')
        ? name
              // Only keep the extension
              .split('.')
              .pop()!
              // Remove any query parameters
              .split('?')
              .shift()!
        : 'unknown';
};

// Returns an object that is safe to serialize to JSON.
// Mostly useful for debugging and testing.
export const serializeBuildReport = (report: BuildReport): SerializedBuildReport => {
    // Report is an object that self reference some of its values.
    // To make it JSON serializable, we need to remove the self references
    // and replace them with strings, we'll use "filepath" to still have them uniquely identifiable.
    const jsonReport: SerializedBuildReport = {
        errors: report.errors,
        warnings: report.warnings,
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
            newEntry.inputs = entry.inputs.map((file: File) => file.filepath);
        }
        if (entry.outputs) {
            newEntry.outputs = entry.outputs.map((file: File) => file.filepath);
        }
        jsonReport.entries.push(newEntry);
    }

    for (const input of report.inputs || []) {
        const newInput: SerializedInput = { ...input, dependencies: [], dependents: [] };
        if (input.dependencies) {
            newInput.dependencies = input.dependencies.map((file: File) => file.filepath);
        }
        if (input.dependents) {
            newInput.dependents = input.dependents.map((file: File) => file.filepath);
        }
        jsonReport.inputs.push(newInput);
    }

    for (const output of report.outputs || []) {
        const newOutput: SerializedOutput = { ...output, inputs: [] };
        if (output.inputs) {
            newOutput.inputs = output.inputs.map((file: File) => file.filepath);
        }
        jsonReport.outputs.push(newOutput);
    }

    return jsonReport;
};

// Returns an object that is unserialized from serializeBuildReport().
// Mostly useful for debugging and testing.
export const unserializeBuildReport = (report: SerializedBuildReport): BuildReport => {
    const buildReport: BuildReport = {
        errors: report.errors,
        warnings: report.warnings,
        start: report.start,
        end: report.end,
        duration: report.duration,
        writeDuration: report.writeDuration,
    };

    const reportInputs = report.inputs || [];
    const reportOutputs = report.outputs || [];

    const entries: Entry[] = [];

    // Prefill inputs and outputs as they are sometimes self-referencing themselves.
    const inputs: Input[] = reportInputs.map<Input>((input) => ({
        ...input,
        // Keep them empty for now, we'll fill them later.
        dependencies: [],
        dependents: [],
    }));
    const outputs: Output[] = reportOutputs.map<Output>((output) => ({ ...output, inputs: [] }));

    // Fill in the inputs' dependencies and dependents.
    for (const input of reportInputs) {
        const newInput: Input = inputs.find((i) => i.filepath === input.filepath)!;

        // Re-assign the dependencies and dependents to the actual objects.
        if (input.dependencies) {
            newInput.dependencies = input.dependencies
                .map<
                    Input | undefined
                >((filepath: string) => inputs.find((i) => i.filepath === filepath))
                .filter(Boolean) as Input[];
        }
        if (input.dependents) {
            newInput.dependents = input.dependents
                .map<
                    Input | undefined
                >((filepath: string) => inputs.find((i) => i.filepath === filepath))
                .filter(Boolean) as Input[];
        }
    }

    // Fill in the outputs' inputs.
    for (const output of reportOutputs) {
        const newOutput: Output = outputs.find((o) => o.filepath === output.filepath)!;
        if (output.inputs) {
            // Re-assign the inputs to the actual objects.
            newOutput.inputs = output.inputs
                .map<
                    // Can be either an input or an output (for sourcemaps).
                    Input | Output | undefined
                >(
                    (filepath: string) =>
                        inputs.find((i) => i.filepath === filepath) ||
                        outputs.find((o) => o.filepath === filepath),
                )
                .filter(Boolean) as (Input | Output)[];
        }
    }

    for (const entry of report.entries || []) {
        const newEntry: Entry = { ...entry, inputs: [], outputs: [] };
        if (entry.inputs) {
            newEntry.inputs = entry.inputs
                .map((filepath: string) => inputs.find((i) => i.filepath === filepath))
                .filter(Boolean) as (Output | Input)[];
        }
        if (entry.outputs) {
            newEntry.outputs = entry.outputs
                .map((filepath: string) => outputs.find((o) => o.filepath === filepath))
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

export const cleanPath = (filepath: string) => {
    let resolvedPath = filepath;
    try {
        resolvedPath = require.resolve(filepath);
    } catch (e) {
        // No problem, we keep the initial path.
    }

    return (
        resolvedPath
            // Remove query parameters.
            .split('?')
            .shift()!
            // Remove leading, invisible characters,
            // sometimes added in rollup by the commonjs plugin.
            .replace(/^[^\w\s.,!@#$%^&*()=+~`\-/]+/, '')
    );
};

export const cleanName = (context: GlobalContext, filepath: string) => {
    if (filepath === 'unknown') {
        return filepath;
    }

    if (filepath.includes('webpack/runtime')) {
        return filepath.replace('webpack/runtime/', '').replace(/ +/g, '-');
    }

    let resolvedPath = filepath;
    try {
        resolvedPath = require.resolve(filepath);
    } catch (e) {
        // No problem, we keep the initial path.
    }

    return (
        resolvedPath
            // Remove outDir's path.
            .replace(context.bundler.outDir, '')
            // Remove the cwd's path.
            .replace(context.cwd, '')
            // Remove node_modules path.
            .split('node_modules')
            .pop()!
            // Remove query parameters.
            .split('?')
            .shift()!
            // Remove leading slashes.
            .replace(/^\/+/, '')
    );
};
