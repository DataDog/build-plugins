// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-console */
import chalk from 'chalk';
import prettyBytes from 'pretty-bytes';

import { HooksContext, Stats, TimingsMap, LocalModules, LocalModule, EsbuildStats } from '../types';
import { formatDuration } from '../helpers';
import { BaseClass } from '../BaseClass';

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

const render = (values: any[], renderValue: (arg: any) => string) => {
    for (const val of values.slice(0, TOP)) {
        console.log(`[${numColor(renderValue(val))}] ${nameColor(val.name)}`);
    }
};

const outputTapables = (timings?: TimingsMap) => {
    if (!timings) {
        return;
    }

    const times = Array.from(timings.values());

    if (!times.length) {
        return;
    }

    // Output
    console.log('\n===== Tapables =====');
    console.log(`\n=== Top ${TOP} duration ===`);
    // Sort by time, longest first
    times.sort(sortDesc('duration'));
    render(times, (time) => formatDuration(time.duration));
    console.log(`\n=== Top ${TOP} hits ===`);
    // Sort by time, longest first
    times.sort(sortDesc('increment'));
    render(times, (plugin) => plugin.increment);
};

export const outputWebpack = (stats: Stats) => {
    console.log('\n===== General =====');
    // More general stuffs.
    const duration = stats.endTime - stats.startTime;
    const nbDeps = stats.compilation.fileDependencies.size;
    // In Webpack 5, stats.compilation.emittedAssets doesn't exist.
    const nbFiles = stats.compilation.assets
        ? Object.keys(stats.compilation.assets).length
        : stats.compilation.emittedAssets.size;
    const nbWarnings = stats.compilation.warnings.length;
    // In Webpack 5, stats.compilation.modules is a Set.
    const nbModules = stats.compilation.modules.size || stats.compilation.modules.length;
    // In Webpack 5, stats.compilation.chunks is a Set.
    const nbChunks = stats.compilation.chunks.size || stats.compilation.chunks.length;
    // In Webpack 5, stats.compilation.entries is a Map.
    const nbEntries = stats.compilation.entries.size || stats.compilation.entries.length;
    console.log(`duration: ${chalk.bold(formatDuration(duration))}
nbDeps: ${chalk.bold(nbDeps.toString())}
nbFiles: ${chalk.bold(nbFiles.toString())}
nbWarnings: ${chalk.bold(nbWarnings.toString())}
nbModules: ${chalk.bold(nbModules.toString())}
nbChunks: ${chalk.bold(nbChunks.toString())}
nbEntries: ${chalk.bold(nbEntries.toString())}
`);
};

export const outputEsbuild = (stats: EsbuildStats) => {
    console.log('\n===== General =====');
    const nbDeps = stats.inputs ? Object.keys(stats.inputs).length : 0;
    const nbFiles = stats.outputs ? Object.keys(stats.outputs).length : 0;
    const nbWarnings = stats.warnings.length;
    const nbErrors = stats.errors.length;
    const nbEntries = stats.entrypoints ? Object.keys(stats.entrypoints).length : 0;

    console.log(`
nbDeps: ${chalk.bold(nbDeps.toString())}
nbFiles: ${chalk.bold(nbFiles.toString())}
nbWarnings: ${chalk.bold(nbWarnings.toString())}
nbErrors: ${chalk.bold(nbErrors.toString())}
nbEntries: ${chalk.bold(nbEntries.toString())}
`);
};

const outputLoaders = (timings?: TimingsMap) => {
    if (!timings) {
        return;
    }

    const times = Array.from(timings.values());

    if (!times.length) {
        return;
    }
    // Output
    console.log('\n===== Loaders =====');
    console.log(`\n=== Top ${TOP} duration ===`);
    // Sort by time, longest first
    times.sort(sortDesc('duration'));
    render(times, (loader) => formatDuration(loader.duration));
    console.log(`\n=== Top ${TOP} hits ===`);
    // Sort by hits, biggest first
    times.sort(sortDesc('increment'));
    render(times, (loader) => loader.increment);
};

const outputModules = (deps: LocalModules, timings?: TimingsMap) => {
    if (!deps && !timings) {
        return;
    }

    if (deps) {
        const dependencies = Object.values(deps);

        if (!dependencies.length) {
            return;
        }

        console.log('\n===== Modules =====');
        // Sort by dependents, biggest first
        dependencies.sort(sortDesc((mod: LocalModule) => mod.dependents.length));
        console.log(`\n=== Top ${TOP} dependents ===`);
        render(dependencies, (module) => module.dependents.length);
        // Sort by dependencies, biggest first
        dependencies.sort(sortDesc((mod: LocalModule) => mod.dependencies.length));
        console.log(`\n=== Top ${TOP} dependencies ===`);
        render(dependencies, (module) => module.dependencies.length);
        // Sort by size, biggest first
        dependencies.sort(sortDesc('size'));
        console.log(`\n=== Top ${TOP} size ===`);
        render(dependencies, (module) => prettyBytes(module.size));
    }
    if (timings) {
        const times = Array.from(timings.values());

        if (!times.length) {
            return;
        }

        console.log('\n===== Modules =====');
        // Sort by duration, longest first
        times.sort(sortDesc('duration'));
        console.log(`\n=== Top ${TOP} duration ===`);
        render(times, (module) => formatDuration(module.duration));
        // Sort by increment, longest first
        times.sort(sortDesc('increment'));
        console.log(`\n=== Top ${TOP} hits ===`);
        render(times, (module) => module.increment);
    }
};

export const hooks = {
    async output(this: BaseClass, { report, bundler }: HooksContext) {
        if (this.options.output === false) {
            return;
        }

        if (report) {
            outputTapables(report.timings.tapables);
            outputLoaders(report.timings.loaders);
            outputModules(report.dependencies, report.timings.modules);
        }
        if (bundler.webpack) {
            outputWebpack(bundler.webpack);
        }
        if (bundler.esbuild) {
            outputEsbuild(bundler.esbuild);
        }
        console.log();
    },
};
