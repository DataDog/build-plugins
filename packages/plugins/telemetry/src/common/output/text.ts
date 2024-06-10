// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { formatDuration } from '@dd/core/helpers';
import chalk from 'chalk';
import prettyBytes from 'pretty-bytes';

import type {
    BundlerContext,
    EsbuildStats,
    LocalModule,
    LocalModules,
    OutputOptions,
    Stats,
    TimingsMap,
} from '../../types';

const TOP = 5;
const numColor = chalk.bold.red;
const nameColor = chalk.bold.cyan;

// Sort a collection by attribute
const sortDesc = (attr: any) => (a: any, b: any) => {
    let aVal;
    let bVal;

    if (typeof attr === 'function') {
        aVal = attr(a);
        bVal = attr(b);
    } else {
        aVal = a[attr];
        bVal = b[attr];
    }

    if (aVal > bVal) {
        return -1;
    } else if (aVal < bVal) {
        return 1;
    } else {
        return 0;
    }
};

const getOutput = (values: any[], renderValue: (arg: any) => string): string => {
    let output = '';
    for (const val of values.slice(0, TOP)) {
        output += `[${numColor(renderValue(val))}] ${nameColor(val.name)}\n`;
    }
    return output;
};

const outputTapables = (timings?: TimingsMap): string => {
    let output = '';

    if (!timings) {
        return output;
    }

    const times = Array.from(timings.values());

    if (!times.length) {
        return output;
    }

    // Output
    output += '\n===== Tapables =====\n';
    output += `\n=== Top ${TOP} duration ===\n`;
    // Sort by time, longest first
    times.sort(sortDesc('duration'));
    output += getOutput(times, (time) => formatDuration(time.duration));
    output += `\n=== Top ${TOP} hits ===\n`;
    // Sort by time, longest first
    times.sort(sortDesc('increment'));
    output += getOutput(times, (plugin) => plugin.increment);

    return output;
};

export const outputWebpack = (stats: Stats): string => {
    let output = '\n===== General =====\n';
    // More general stuffs.
    const duration = stats.endTime - stats.startTime;
    const nbDeps = stats.compilation.fileDependencies.size;
    // In Webpack 5, stats.compilation.emittedAssets doesn't exist.
    const nbFiles = stats.compilation.assets
        ? Object.keys(stats.compilation.assets).length
        : stats.compilation.emittedAssets.size;
    const nbWarnings = stats.compilation.warnings.length;
    // In Webpack 5, stats.compilation.modules is a Set.
    const nbModules =
        'size' in stats.compilation.modules
            ? stats.compilation.modules.size
            : stats.compilation.modules.length;
    // In Webpack 5, stats.compilation.chunks is a Set.
    const nbChunks =
        'size' in stats.compilation.chunks
            ? stats.compilation.chunks.size
            : stats.compilation.chunks.length;
    // In Webpack 5, stats.compilation.entries is a Map.
    const nbEntries =
        'size' in stats.compilation.entries
            ? stats.compilation.entries.size
            : stats.compilation.entries.length;
    output += `duration: ${chalk.bold(formatDuration(duration))}
nbDeps: ${chalk.bold(nbDeps.toString())}
nbFiles: ${chalk.bold(nbFiles.toString())}
nbWarnings: ${chalk.bold(nbWarnings.toString())}
nbModules: ${chalk.bold(nbModules.toString())}
nbChunks: ${chalk.bold(nbChunks.toString())}
nbEntries: ${chalk.bold(nbEntries.toString())}
`;
    return output;
};

export const outputEsbuild = (stats: EsbuildStats) => {
    let output = '\n===== General =====\n';
    const nbDeps = stats.inputs ? Object.keys(stats.inputs).length : 0;
    const nbFiles = stats.outputs ? Object.keys(stats.outputs).length : 0;
    const nbWarnings = stats.warnings.length;
    const nbErrors = stats.errors.length;
    const nbEntries = stats.entrypoints ? Object.keys(stats.entrypoints).length : 0;

    output += `
nbDeps: ${chalk.bold(nbDeps.toString())}
nbFiles: ${chalk.bold(nbFiles.toString())}
nbWarnings: ${chalk.bold(nbWarnings.toString())}
nbErrors: ${chalk.bold(nbErrors.toString())}
nbEntries: ${chalk.bold(nbEntries.toString())}
`;
    return output;
};

const outputLoaders = (timings?: TimingsMap): string => {
    let output = '';

    if (!timings) {
        return output;
    }

    const times = Array.from(timings.values());

    if (!times.length) {
        return output;
    }

    // Output
    output += '\n===== Loaders =====\n';
    output += `\n=== Top ${TOP} duration ===\n`;
    // Sort by time, longest first
    times.sort(sortDesc('duration'));
    output += getOutput(times, (loader) => formatDuration(loader.duration));
    output += `\n=== Top ${TOP} hits ===\n`;
    // Sort by hits, biggest first
    times.sort(sortDesc('increment'));
    output += getOutput(times, (loader) => loader.increment);

    return output;
};

const outputModulesDependencies = (deps: LocalModules): string => {
    let output = '';

    if (!deps) {
        return output;
    }

    const dependencies = Object.values(deps);

    if (!dependencies.length) {
        return output;
    }

    output += '\n===== Modules =====\n';
    // Sort by dependents, biggest first
    dependencies.sort(sortDesc((mod: LocalModule) => mod.dependents.length));
    output += `\n=== Top ${TOP} dependents ===\n`;
    output += getOutput(dependencies, (module) => module.dependents.length);
    // Sort by dependencies, biggest first
    dependencies.sort(sortDesc((mod: LocalModule) => mod.dependencies.length));
    output += `\n=== Top ${TOP} dependencies ===\n`;
    output += getOutput(dependencies, (module) => module.dependencies.length);
    // Sort by size, biggest first
    dependencies.sort(sortDesc('size'));
    output += `\n=== Top ${TOP} size ===\n`;
    output += getOutput(dependencies, (module) => prettyBytes(module.size));

    return output;
};

const outputModulesTimings = (timings?: TimingsMap): string => {
    let output = '';

    if (!timings) {
        return output;
    }

    const times = Array.from(timings.values());

    if (!times.length) {
        return output;
    }

    output += '\n===== Modules =====\n';
    // Sort by duration, longest first
    times.sort(sortDesc('duration'));
    output += `\n=== Top ${TOP} duration ===\n`;
    output += getOutput(times, (module) => formatDuration(module.duration));
    // Sort by increment, longest first
    times.sort(sortDesc('increment'));
    output += `\n=== Top ${TOP} hits ===\n`;
    output += getOutput(times, (module) => module.increment);

    return output;
};

const shouldShowOutput = (output?: OutputOptions): boolean => {
    if (typeof output === 'boolean') {
        return output;
    }

    // If we passed a path, we should output as stated in the docs.
    if (typeof output === 'string') {
        return true;
    }

    // If we passed nothing, default is true.
    if (!output) {
        return true;
    }

    // Finally, if we passed an object, we should check if logs are enabled.
    return output.logs !== false;
};

export const outputTexts = (bundlerContext: BundlerContext, output?: OutputOptions) => {
    const { report, bundler } = bundlerContext;

    if (!shouldShowOutput(output)) {
        return;
    }

    let outputString = '';

    if (report) {
        outputString += outputTapables(report.timings.tapables);
        outputString += outputLoaders(report.timings.loaders);
        outputString += outputModulesDependencies(report.dependencies);
        outputString += outputModulesTimings(report.timings.modules);
    }
    if (bundler.webpack) {
        outputString += outputWebpack(bundler.webpack);
    }
    if (bundler.esbuild) {
        outputString += outputEsbuild(bundler.esbuild);
    }

    // We're using console.log here because the configuration expressely asked us to print it.
    // eslint-disable-next-line no-console
    console.log(outputString);
};
