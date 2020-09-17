// Unless explicitly stated otherwise all files in this repository are licensed
// under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-console */
import chalk from 'chalk';

import { BuildPlugin } from '../webpack';
import {
    HooksContext,
    Stats,
    TapableTimings,
    ResultLoaders,
    ResultModules,
    LocalModules,
    LocalModule,
} from '../types';

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

// Format a duration 0h 0m 0s 0ms
const formatDuration = (duration: number) => {
    const d = new Date(duration);
    const hours = d.getUTCHours();
    const minutes = d.getUTCMinutes();
    const seconds = d.getUTCSeconds();
    const milliseconds = d.getUTCMilliseconds();
    return `${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${
        seconds ? `${seconds}s ` : ''
    }${milliseconds}ms`.trim();
};

const render = (values: any[], renderValue: (arg: any) => string) => {
    for (const val of values.slice(0, TOP)) {
        console.log(`[${numColor(renderValue(val))}] ${nameColor(val.name)}`);
    }
};

const outputTapables = (timings: TapableTimings) => {
    const times = Object.values(timings);

    // Sort by time, longest first
    times.sort(sortDesc('duration'));

    // Output
    console.log('\n===== Tapables =====');
    console.log(`\n=== Top ${TOP} duration ===`);
    render(times, (time) => formatDuration(time.duration));
};

const outputGenerals = (stats: Stats) => {
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
    const nbChunks = stats.compilation.chunks.length;
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

const outputLoaders = (times: ResultLoaders) => {
    // Sort by time, longest first
    const loadersPerTime = Object.values(times).sort(sortDesc('duration'));
    // Sort by hits, biggest first
    const loadersPerIncrement = Object.values(times).sort(sortDesc('increment'));

    // Output
    console.log('\n===== Loaders =====');
    console.log(`\n=== Top ${TOP} duration ===`);
    render(loadersPerTime, (loader) => formatDuration(loader.duration));
    console.log(`\n=== Top ${TOP} hits ===`);
    render(loadersPerIncrement, (loader) => loader.increment);
};

const outputModules = (times: ResultModules, deps: LocalModules) => {
    // Sort by dependents, biggest first
    const modulesPerDependents = Object.values(deps).sort(
        sortDesc((mod: LocalModule) => mod.dependents.length)
    );
    // Sort by dependencies, biggest first
    const modulesPerDepencies = Object.values(deps).sort(
        sortDesc((mod: LocalModule) => mod.dependencies.length)
    );
    // Sort by duration, longest first
    const modulesPerTime = Object.values(times).sort(sortDesc('duration'));

    // Output
    console.log('\n===== Modules =====');
    console.log(`\n=== Top ${TOP} dependents ===`);
    render(modulesPerDependents, (module) => module.dependents.length);
    console.log(`\n=== Top ${TOP} dependencies ===`);
    render(modulesPerDepencies, (module) => module.dependencies.length);
    console.log(`\n=== Top ${TOP} duration ===`);
    render(modulesPerTime, (module) => formatDuration(module.duration));
};

module.exports = {
    hooks: {
        async output(this: BuildPlugin, { report, stats }: HooksContext) {
            if (this.options.output === false) {
                return;
            }
            outputTapables(report.timings.tapables);
            outputLoaders(report.timings.loaders);
            outputModules(report.timings.modules, report.dependencies);
            outputGenerals(stats);
        },
    },
};
