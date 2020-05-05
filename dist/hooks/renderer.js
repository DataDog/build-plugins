"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable no-console */
const chalk = require('chalk');
const TOP = 5;
const numColor = chalk.bold.red;
const nameColor = chalk.bold.cyan;
// Sort a collection by attribute
const sortDesc = (attr) => (a, b) => {
    let aVal;
    let bVal;
    if (typeof attr === 'function') {
        aVal = attr(a);
        bVal = attr(b);
    }
    else {
        aVal = a[attr];
        bVal = b[attr];
    }
    if (aVal > bVal) {
        return -1;
    }
    else if (aVal < bVal) {
        return 1;
    }
    else {
        return 0;
    }
};
// Format a duration 0h 0m 0s 0ms
const formatDuration = (duration) => {
    const d = new Date(duration);
    const hours = d.getUTCHours();
    const minutes = d.getUTCMinutes();
    const seconds = d.getUTCSeconds();
    const milliseconds = d.getUTCMilliseconds();
    return `${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${seconds ? `${seconds}s ` : ''}${milliseconds}ms`.trim();
};
const render = (values, renderValue) => {
    for (const val of values.slice(0, TOP)) {
        console.log(`[${numColor(renderValue(val))}] ${nameColor(val.name)}`);
    }
};
const outputTappables = (timings) => {
    const times = Object.values(timings);
    // Sort by time, longest first
    times.sort(sortDesc('duration'));
    // Output
    console.log('\n===== Tappables =====');
    console.log(`\n=== Top ${TOP} duration ===`);
    render(times, (time) => formatDuration(time.duration));
};
const outputGenerals = (stats) => {
    console.log('\n===== General =====');
    // More general stuffs.
    const duration = stats.endTime - stats.startTime;
    const nbDeps = stats.compilation.fileDependencies.size;
    const nbFiles = stats.compilation.emittedAssets.size;
    const nbWarnings = stats.compilation.warnings.length;
    const nbModules = stats.compilation.modules.length;
    const nbChunks = stats.compilation.chunks.length;
    const nbEntries = stats.compilation.entries.length;
    console.log(`duration: ${chalk.bold(formatDuration(duration))}
nbDeps: ${chalk.bold(nbDeps)}
nbFiles: ${chalk.bold(nbFiles)}
nbWarnings: ${chalk.bold(nbWarnings)}
nbModules: ${chalk.bold(nbModules)}
nbChunks: ${chalk.bold(nbChunks)}
nbEntries: ${chalk.bold(nbEntries)}
`);
};
const outputLoaders = (times) => {
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
const outputModules = (times, deps) => {
    // Sort by dependents, biggest first
    const modulesPerDependents = Object.values(deps).sort(sortDesc((mod) => mod.dependents.length));
    // Sort by dependencies, biggest first
    const modulesPerDepencies = Object.values(deps).sort(sortDesc((mod) => mod.dependencies.length));
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
        output({ report, stats }) {
            return __awaiter(this, void 0, void 0, function* () {
                if (this.options.output === false) {
                    return;
                }
                outputTappables(report.timings.tappables);
                outputLoaders(report.timings.loaders);
                outputModules(report.timings.modules, report.dependencies);
                outputGenerals(stats);
            });
        },
    },
};
