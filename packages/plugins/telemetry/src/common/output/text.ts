// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { formatDuration } from '@dd/core/helpers';
import type { Stats, TimingsMap, LocalModules, LocalModule, EsbuildStats } from '@dd/core/types';
import chalk from 'chalk';
import prettyBytes from 'pretty-bytes';

import { CONFIG_KEY } from '../../constants';
import type { Context, OptionsWithTelemetryEnabled } from '../../types';
import { getLogFn, getLogLevel } from '../helpers';

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
    let st = '';
    for (const val of values.slice(0, TOP)) {
        st += `[${numColor(renderValue(val))}] ${nameColor(val.name)}\n`;
    }
    return st;
};

const outputTapables = (timings?: TimingsMap): string => {
    let st = '';

    if (!timings) {
        return st;
    }

    const times = Array.from(timings.values());

    if (!times.length) {
        return st;
    }

    // Output
    st += '\n===== Tapables =====\n';
    st += `\n=== Top ${TOP} duration ===\n`;
    // Sort by time, longest first
    times.sort(sortDesc('duration'));
    st += getOutput(times, (time) => formatDuration(time.duration));
    st += `\n=== Top ${TOP} hits ===\n`;
    // Sort by time, longest first
    times.sort(sortDesc('increment'));
    st += getOutput(times, (plugin) => plugin.increment);

    return st;
};

export const outputWebpack = (stats: Stats): string => {
    let st = '\n===== General =====\n';
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
    st += `duration: ${chalk.bold(formatDuration(duration))}
nbDeps: ${chalk.bold(nbDeps.toString())}
nbFiles: ${chalk.bold(nbFiles.toString())}
nbWarnings: ${chalk.bold(nbWarnings.toString())}
nbModules: ${chalk.bold(nbModules.toString())}
nbChunks: ${chalk.bold(nbChunks.toString())}
nbEntries: ${chalk.bold(nbEntries.toString())}
`;
    return st;
};

export const outputEsbuild = (stats: EsbuildStats) => {
    let st = '\n===== General =====\n';
    const nbDeps = stats.inputs ? Object.keys(stats.inputs).length : 0;
    const nbFiles = stats.outputs ? Object.keys(stats.outputs).length : 0;
    const nbWarnings = stats.warnings.length;
    const nbErrors = stats.errors.length;
    const nbEntries = stats.entrypoints ? Object.keys(stats.entrypoints).length : 0;

    st += `
nbDeps: ${chalk.bold(nbDeps.toString())}
nbFiles: ${chalk.bold(nbFiles.toString())}
nbWarnings: ${chalk.bold(nbWarnings.toString())}
nbErrors: ${chalk.bold(nbErrors.toString())}
nbEntries: ${chalk.bold(nbEntries.toString())}
`;
    return st;
};

const outputLoaders = (timings?: TimingsMap): string => {
    let st = '';

    if (!timings) {
        return st;
    }

    const times = Array.from(timings.values());

    if (!times.length) {
        return st;
    }

    // Output
    st += '\n===== Loaders =====\n';
    st += `\n=== Top ${TOP} duration ===\n`;
    // Sort by time, longest first
    times.sort(sortDesc('duration'));
    st += getOutput(times, (loader) => formatDuration(loader.duration));
    st += `\n=== Top ${TOP} hits ===\n`;
    // Sort by hits, biggest first
    times.sort(sortDesc('increment'));
    st += getOutput(times, (loader) => loader.increment);

    return st;
};

const outputModulesDependencies = (deps: LocalModules): string => {
    let st = '';

    if (!deps) {
        return st;
    }

    const dependencies = Object.values(deps);

    if (!dependencies.length) {
        return st;
    }

    st += '\n===== Modules =====\n';
    // Sort by dependents, biggest first
    dependencies.sort(sortDesc((mod: LocalModule) => mod.dependents.length));
    st += `\n=== Top ${TOP} dependents ===\n`;
    st += getOutput(dependencies, (module) => module.dependents.length);
    // Sort by dependencies, biggest first
    dependencies.sort(sortDesc((mod: LocalModule) => mod.dependencies.length));
    st += `\n=== Top ${TOP} dependencies ===\n`;
    st += getOutput(dependencies, (module) => module.dependencies.length);
    // Sort by size, biggest first
    dependencies.sort(sortDesc('size'));
    st += `\n=== Top ${TOP} size ===\n`;
    st += getOutput(dependencies, (module) => prettyBytes(module.size));

    return st;
};

const outputModulesTimings = (timings?: TimingsMap): string => {
    let st = '';

    if (!timings) {
        return st;
    }

    const times = Array.from(timings.values());

    if (!times.length) {
        return st;
    }

    st += '\n===== Modules =====\n';
    // Sort by duration, longest first
    times.sort(sortDesc('duration'));
    st += `\n=== Top ${TOP} duration ===\n`;
    st += getOutput(times, (module) => formatDuration(module.duration));
    // Sort by increment, longest first
    times.sort(sortDesc('increment'));
    st += `\n=== Top ${TOP} hits ===\n`;
    st += getOutput(times, (module) => module.increment);

    return st;
};

export const outputTexts = (context: Context, options: OptionsWithTelemetryEnabled) => {
    const { output } = options[CONFIG_KEY];
    const { report, bundler } = context;
    const log = getLogFn(getLogLevel(options[CONFIG_KEY].output));

    if (output === false) {
        return;
    }

    let st = '';

    if (report) {
        st += outputTapables(report.timings.tapables);
        st += outputLoaders(report.timings.loaders);
        st += outputModulesDependencies(report.dependencies);
        st += outputModulesTimings(report.timings.modules);
    }
    if (bundler.webpack) {
        st += outputWebpack(bundler.webpack);
    }
    if (bundler.esbuild) {
        st += outputEsbuild(bundler.esbuild);
    }

    log(st);
};
