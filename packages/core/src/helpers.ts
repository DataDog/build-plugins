// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import type { PluginBuild } from 'esbuild';
import fs from 'fs';
import { glob } from 'glob';
import path from 'path';

import { outputJsonSync } from './helpers/fs';
import type {
    BuildReport,
    BundlerFullName,
    Entry,
    File,
    GetCustomPlugins,
    GlobalContext,
    Input,
    IterableElement,
    Logger,
    Output,
    ResolvedEntry,
    SerializedBuildReport,
    SerializedEntry,
    SerializedInput,
    SerializedOutput,
} from './types';

// Format a duration 0h 0m 0s 0ms
export const formatDuration = (duration: number) => {
    const days = Math.floor(duration / 1000 / 60 / 60 / 24);
    const usedDuration = duration - days * 24 * 60 * 60 * 1000;
    const d = new Date(usedDuration);
    const hours = d.getUTCHours();
    const minutes = d.getUTCMinutes();
    const seconds = d.getUTCSeconds();
    const milliseconds = d.getUTCMilliseconds();
    const timeString =
        `${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${
            seconds ? `${seconds}s` : ''
        }`.trim();
    // Split here so we can show 0ms in case we have a duration of 0.
    return `${timeString}${!timeString || milliseconds ? ` ${milliseconds}ms` : ''}`.trim();
};

// https://esbuild.github.io/api/#glob-style-entry-points
const getAllEntryFiles = (filepath: string): string[] => {
    if (!filepath.includes('*')) {
        return [filepath];
    }

    const files = glob.sync(filepath);
    return files;
};

// Parse, resolve and return all the entries of esbuild.
export const getEsbuildEntries = async (
    build: PluginBuild,
    context: GlobalContext,
    log: Logger,
): Promise<ResolvedEntry[]> => {
    const entries: { name?: string; resolved: string; original: string }[] = [];
    const entryPoints = build.initialOptions.entryPoints;
    const entryPaths: { name?: string; path: string }[] = [];
    const resolutionErrors: string[] = [];

    if (Array.isArray(entryPoints)) {
        for (const entry of entryPoints) {
            const fullPath = entry && typeof entry === 'object' ? entry.in : entry;
            entryPaths.push({ path: fullPath });
        }
    } else if (entryPoints && typeof entryPoints === 'object') {
        entryPaths.push(
            ...Object.entries(entryPoints).map(([name, filepath]) => ({ name, path: filepath })),
        );
    }

    // Resolve all the paths.
    const proms = entryPaths
        .flatMap((entry) =>
            getAllEntryFiles(entry.path).map<[{ name?: string; path: string }, string]>((p) => [
                entry,
                p,
            ]),
        )
        .map(async ([entry, p]) => {
            const result = await build.resolve(p, {
                kind: 'entry-point',
                resolveDir: context.cwd,
            });

            if (result.errors.length) {
                resolutionErrors.push(...result.errors.map((e) => e.text));
            }

            if (result.path) {
                // Store them for later use.
                entries.push({
                    name: entry.name,
                    resolved: result.path,
                    original: entry.path,
                });
            }
        });

    for (const resolutionError of resolutionErrors) {
        log.error(resolutionError);
    }

    await Promise.all(proms);
    return entries;
};

// Truncate a string to a certain length.
// Placing a [...] placeholder in the middle.
// "A way too long sentence could be truncated a bit." => "A way too[...]could be truncated a bit."
export const truncateString = (
    str: string,
    maxLength: number = 60,
    placeholder: string = '[...]',
) => {
    if (str.length <= maxLength) {
        return str;
    }

    // We want to keep at the very least 4 characters.
    const stringLength = Math.max(4, maxLength - placeholder.length);

    // We want to keep most of the end of the string, hence the 10 chars top limit for left.
    const leftStop = Math.min(10, Math.floor(stringLength / 2));
    const rightStop = stringLength - leftStop;

    return `${str.slice(0, leftStop)}${placeholder}${str.slice(-rightStop)}`;
};

// Is the file coming from the injection plugin?
export const isInjectionFile = (filename: string) => filename.includes(INJECTED_FILE);

// From a bundler's name, is it part of the "xpack" family?
export const isXpack = (bundlerName: BundlerFullName) =>
    ['rspack', 'webpack4', 'webpack5', 'webpack'].includes(bundlerName);

let index = 0;
export const getUniqueId = () => `${Date.now()}.${performance.now()}.${++index}`;

// Returns an object that is safe to serialize to JSON.
// Mostly useful for debugging and testing.
export const serializeBuildReport = (report: BuildReport): SerializedBuildReport => {
    // Report is an object that self reference some of its values.
    // To make it JSON serializable, we need to remove the self references
    // and replace them with strings, we'll use "filepath" to still have them uniquely identifiable.
    const jsonReport: SerializedBuildReport = {
        bundler: report.bundler,
        errors: report.errors,
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
        bundler: report.bundler,
        errors: report.errors,
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

// Will only prepend the cwd if not already there.
export const getAbsolutePath = (cwd: string, filepath: string) => {
    if (isInjectionFile(filepath)) {
        return INJECTED_FILE;
    }

    if (filepath.startsWith(cwd) || path.isAbsolute(filepath)) {
        return filepath;
    }
    return path.resolve(cwd, filepath);
};

// Find the highest package.json from the current directory.
export const getHighestPackageJsonDir = (currentDir: string): string | undefined => {
    let highestPackage;
    let current = getAbsolutePath(process.cwd(), currentDir);
    let currentDepth = current.split('/').length;
    while (currentDepth > 0) {
        const packagePath = path.resolve(current, `package.json`);
        // Check if package.json exists in the current directory.
        if (fs.existsSync(packagePath)) {
            highestPackage = current;
        }
        // Remove the last part of the path.
        current = current.split('/').slice(0, -1).join('/');
        currentDepth--;
    }
    return highestPackage;
};

// From a list of path, return the nearest common directory.
export const getNearestCommonDirectory = (dirs: string[], cwd?: string) => {
    const dirsToCompare = [...dirs];

    // We include the CWD because it's part of the paths we want to compare.
    if (cwd) {
        dirsToCompare.push(cwd);
    }

    const splitPaths = dirsToCompare.map((dir) => {
        const absolutePath = getAbsolutePath(cwd || process.cwd(), dir);
        return absolutePath.split(path.sep);
    });

    // Use the shortest length for faster results.
    const minLength = Math.min(...splitPaths.map((parts) => parts.length));
    const commonParts = [];

    for (let i = 0; i < minLength; i++) {
        // We use the first path as our basis.
        const component = splitPaths[0][i];
        if (splitPaths.every((parts) => parts[i] === component)) {
            commonParts.push(component);
        } else {
            break;
        }
    }

    return commonParts.length > 0
        ? // Use "|| path.sep" to cover for the [''] case.
          commonParts.join(path.sep) || path.sep
        : path.sep;
};

// Returns a customPlugin to output some debug files.
type CustomPlugins = ReturnType<GetCustomPlugins>;
export const debugFilesPlugins = (context: GlobalContext): CustomPlugins => {
    const rollupPlugin: IterableElement<CustomPlugins>['rollup'] = {
        writeBundle(options, bundle) {
            outputJsonSync(
                path.resolve(context.bundler.outDir, `output.${context.bundler.fullName}.json`),
                bundle,
            );
        },
    };

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
            outputJsonSync(
                path.resolve(context.bundler.outDir, `output.${context.bundler.fullName}.json`),
                statsJson,
            );
        });
    };

    return [
        {
            name: 'build-report',
            enforce: 'post',
            writeBundle() {
                outputJsonSync(
                    path.resolve(context.bundler.outDir, `report.${context.bundler.fullName}.json`),
                    serializeBuildReport(context.build),
                );
            },
        },
        {
            name: 'bundler-outputs',
            enforce: 'post',
            esbuild: {
                setup(build) {
                    build.onEnd((result) => {
                        outputJsonSync(
                            path.resolve(
                                context.bundler.outDir,
                                `output.${context.bundler.fullName}.json`,
                            ),
                            result.metafile,
                        );
                    });
                },
            },
            rspack: xpackPlugin,
            rollup: rollupPlugin,
            vite: rollupPlugin,
            webpack: xpackPlugin,
        },
    ];
};
