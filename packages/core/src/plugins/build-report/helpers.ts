// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { isInjection } from '@dd/core/helpers';
import { INJECTED_FILE } from '@dd/core/plugins/injection/constants';
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
} from '@dd/core/types';
import path from 'path';

// Will match any last part of a path after a dot or slash and is a word character.
const EXTENSION_RX = /\.(?!.*(?:\.|\/|\\))(\w{1,})/g;

// Will match any type of query characters.
const QUERY_RX = /(\?|%3F|\|)+/gi;

const getExtension = (filepath: string) => {
    // Reset RX first.
    EXTENSION_RX.lastIndex = 0;
    return EXTENSION_RX.exec(filepath)?.[1];
};

export const getType = (name: string): string => {
    if (name === 'unknown') {
        return name;
    }

    if (name.includes('webpack/runtime')) {
        return 'runtime';
    }

    return getExtension(cleanPath(name)) || 'unknown';
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

const BUNDLER_SPECIFICS = ['unknown', 'commonjsHelpers.js', 'vite/preload-helper.js'];
// Make list of paths unique, remove the current file and particularities.
export const cleanReport = <T = string>(
    report: Set<string>,
    filepath: string,
    filter?: (p: string) => T,
) => {
    const cleanedReport: Set<T> = new Set();
    for (const reportFilepath of report) {
        const cleanedPath = cleanPath(reportFilepath);
        if (
            // Don't add injections.
            isInjection(reportFilepath) ||
            // Don't add itself into it.
            cleanedPath === filepath ||
            // Remove common specific files injected by bundlers.
            BUNDLER_SPECIFICS.includes(cleanedPath)
        ) {
            continue;
        }

        if (filter) {
            const filteredValue = filter(cleanedPath);
            if (filteredValue) {
                cleanedReport.add(filteredValue);
            }
        } else {
            cleanedReport.add(cleanedPath as unknown as T);
        }
    }
    return cleanedReport;
};

// Clean a path from its query parameters and leading invisible characters.
export const cleanPath = (filepath: string) => {
    return (
        filepath
            // [webpack] Only keep the loaded part of a loader query.
            .split('!')
            .pop()!
            // Remove query parameters.
            .split(QUERY_RX)
            .shift()!
            // Remove leading, invisible characters,
            // sometimes added in rollup by the commonjs plugin.
            .replace(/^[^\w\s.,!@#$%^&*()=+~`\-/]+/, '')
    );
};

// Will only prepend the cwd if not already there.
export const getAbsolutePath = (cwd: string, filepath: string) => {
    if (isInjection(filepath)) {
        return INJECTED_FILE;
    }

    if (filepath.startsWith(cwd)) {
        return filepath;
    }
    return path.resolve(cwd, filepath);
};

// Extract a name from a path based on the context (out dir and cwd).
export const cleanName = (context: GlobalContext, filepath: string) => {
    if (isInjection(filepath)) {
        return INJECTED_FILE;
    }

    if (filepath === 'unknown') {
        return filepath;
    }

    if (filepath.includes('webpack/runtime')) {
        return filepath.replace('webpack/runtime/', '').replace(/ +/g, '-');
    }

    return (
        filepath
            // [webpack] Only keep the loaded part of a loader query.
            .split('!')
            .pop()!
            // Remove outDir's path.
            .replace(context.bundler.outDir, '')
            // Remove the cwd's path.
            .replace(context.cwd, '')
            // Remove node_modules path.
            .split('node_modules')
            .pop()!
            // Remove query parameters.
            .split(QUERY_RX)
            .shift()!
            // Remove leading slashes.
            .replace(/^\/+/, '')
    );
};
