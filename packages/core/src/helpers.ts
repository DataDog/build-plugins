// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import retry from 'async-retry';
import type { PluginBuild } from 'esbuild';
import fsp from 'fs/promises';
import fs from 'fs';
import { glob } from 'glob';
import path from 'path';
import type { RequestInit } from 'undici-types';

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
    RequestOpts,
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

export const ERROR_CODES_NO_RETRY = [400, 403, 413];
export const NB_RETRIES = 5;
// Do a retriable fetch.
export const doRequest = <T>(opts: RequestOpts): Promise<T> => {
    const { auth, url, method = 'GET', getData, type = 'text' } = opts;
    const retryOpts: retry.Options = {
        retries: opts.retries === 0 ? 0 : opts.retries || NB_RETRIES,
        onRetry: opts.onRetry,
        maxTimeout: opts.maxTimeout,
        minTimeout: opts.minTimeout,
    };

    return retry(async (bail: (e: Error) => void, attempt: number) => {
        let response: Response;
        try {
            const requestInit: RequestInit = {
                method,
                // This is needed for sending body in NodeJS' Fetch.
                // https://github.com/nodejs/node/issues/46221
                duplex: 'half',
            };
            let requestHeaders: RequestInit['headers'] = {};

            // Do auth if present.
            if (auth?.apiKey) {
                requestHeaders['DD-API-KEY'] = auth.apiKey;
            }

            if (auth?.appKey) {
                requestHeaders['DD-APPLICATION-KEY'] = auth.appKey;
            }

            if (typeof getData === 'function') {
                const { data, headers } = await getData();
                requestInit.body = data;
                requestHeaders = { ...requestHeaders, ...headers };
            }

            response = await fetch(url, { ...requestInit, headers: requestHeaders });
        } catch (error: any) {
            // We don't want to retry if there is a non-fetch related error.
            bail(error);
            // bail(error) throws so the return is never executed.
            return {} as T;
        }

        if (!response.ok) {
            // Not instantiating the error here, as it will make Jest throw in the tests.
            const errorMessage = `HTTP ${response.status} ${response.statusText}`;
            if (ERROR_CODES_NO_RETRY.includes(response.status)) {
                bail(new Error(errorMessage));
                // bail(error) throws so the return is never executed.
                return {} as T;
            } else {
                // Trigger the retry.
                throw new Error(errorMessage);
            }
        }

        try {
            let result;
            // Await it so we catch any parsing error and bail.
            if (type === 'json') {
                result = await response.json();
            } else {
                result = await response.text();
            }

            return result as T;
        } catch (error: any) {
            // We don't want to retry on parsing errors.
            bail(error);
            // bail(error) throws so the return is never executed.
            return {} as T;
        }
    }, retryOpts);
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

// Replacing fs-extra with local helpers.
// Delete folders recursively.
export const rm = async (dir: string) => {
    return fsp.rm(dir, { force: true, maxRetries: 3, recursive: true });
};
export const rmSync = async (dir: string) => {
    return fs.rmSync(dir, { force: true, maxRetries: 3, recursive: true });
};

// Mkdir recursively.
export const mkdir = async (dir: string) => {
    return fsp.mkdir(dir, { recursive: true });
};

export const mkdirSync = (dir: string) => {
    return fs.mkdirSync(dir, { recursive: true });
};

// Write a file but first ensure the directory exists.
export const outputFile = async (filepath: string, data: string) => {
    await mkdir(path.dirname(filepath));
    await fsp.writeFile(filepath, data, { encoding: 'utf-8' });
};

export const outputFileSync = (filepath: string, data: string) => {
    mkdirSync(path.dirname(filepath));
    fs.writeFileSync(filepath, data, { encoding: 'utf-8' });
};

// Output a JSON file.
export const outputJson = async (filepath: string, data: any) => {
    // FIXME: This will crash on strings too long.
    const dataString = JSON.stringify(data, null, 4);
    return outputFile(filepath, dataString);
};

export const outputJsonSync = (filepath: string, data: any) => {
    // FIXME: This will crash on strings too long.
    const dataString = JSON.stringify(data, null, 4);
    outputFileSync(filepath, dataString);
};

// Read a JSON file.
export const readJsonSync = (filepath: string) => {
    const data = fs.readFileSync(filepath, { encoding: 'utf-8' });
    return JSON.parse(data);
};

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

// From a list of path, return the nearest common directory.
export const getNearestCommonDirectory = (dirs: string[], cwd?: string) => {
    const dirsToCompare = [...dirs];

    // We include the CWD because it's part of the paths we want to compare.
    if (cwd) {
        dirsToCompare.push(cwd);
    }

    const splitPaths = dirsToCompare.map((dir) => {
        const absolutePath = cwd ? getAbsolutePath(cwd, dir) : dir;
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

    return commonParts.length > 0 ? commonParts.join(path.sep) : path.sep;
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
