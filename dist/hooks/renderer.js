"use strict";
// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable no-console */
const chalk_1 = __importDefault(require("chalk"));
const pretty_bytes_1 = __importDefault(require("pretty-bytes"));
const helpers_1 = require("../helpers");
const TOP = 5;
const numColor = chalk_1.default.bold.red;
const nameColor = chalk_1.default.bold.cyan;
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
const render = (values, renderValue) => {
    for (const val of values.slice(0, TOP)) {
        console.log(`[${numColor(renderValue(val))}] ${nameColor(val.name)}`);
    }
};
const outputTapables = (timings) => {
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
    render(times, (time) => helpers_1.formatDuration(time.duration));
    console.log(`\n=== Top ${TOP} hits ===`);
    // Sort by time, longest first
    times.sort(sortDesc('increment'));
    render(times, (plugin) => plugin.increment);
};
exports.outputWebpack = (stats) => {
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
    console.log(`duration: ${chalk_1.default.bold(helpers_1.formatDuration(duration))}
nbDeps: ${chalk_1.default.bold(nbDeps.toString())}
nbFiles: ${chalk_1.default.bold(nbFiles.toString())}
nbWarnings: ${chalk_1.default.bold(nbWarnings.toString())}
nbModules: ${chalk_1.default.bold(nbModules.toString())}
nbChunks: ${chalk_1.default.bold(nbChunks.toString())}
nbEntries: ${chalk_1.default.bold(nbEntries.toString())}
`);
};
exports.outputEsbuild = (stats) => {
    console.log('\n===== General =====');
    const nbDeps = stats.inputs ? Object.keys(stats.inputs).length : 0;
    const nbFiles = stats.outputs ? Object.keys(stats.outputs).length : 0;
    const nbWarnings = stats.warnings.length;
    const nbErrors = stats.errors.length;
    const nbEntries = stats.entrypoints ? Object.keys(stats.entrypoints).length : 0;
    console.log(`
nbDeps: ${chalk_1.default.bold(nbDeps.toString())}
nbFiles: ${chalk_1.default.bold(nbFiles.toString())}
nbWarnings: ${chalk_1.default.bold(nbWarnings.toString())}
nbErrors: ${chalk_1.default.bold(nbErrors.toString())}
nbEntries: ${chalk_1.default.bold(nbEntries.toString())}
`);
};
const outputLoaders = (timings) => {
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
    render(times, (loader) => helpers_1.formatDuration(loader.duration));
    console.log(`\n=== Top ${TOP} hits ===`);
    // Sort by hits, biggest first
    times.sort(sortDesc('increment'));
    render(times, (loader) => loader.increment);
};
const outputModules = (deps, timings) => {
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
        dependencies.sort(sortDesc((mod) => mod.dependents.length));
        console.log(`\n=== Top ${TOP} dependents ===`);
        render(dependencies, (module) => module.dependents.length);
        // Sort by dependencies, biggest first
        dependencies.sort(sortDesc((mod) => mod.dependencies.length));
        console.log(`\n=== Top ${TOP} dependencies ===`);
        render(dependencies, (module) => module.dependencies.length);
        // Sort by size, biggest first
        dependencies.sort(sortDesc('size'));
        console.log(`\n=== Top ${TOP} size ===`);
        render(dependencies, (module) => pretty_bytes_1.default(module.size));
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
        render(times, (module) => helpers_1.formatDuration(module.duration));
        // Sort by increment, longest first
        times.sort(sortDesc('increment'));
        console.log(`\n=== Top ${TOP} hits ===`);
        render(times, (module) => module.increment);
    }
};
exports.hooks = {
    output({ report, bundler }) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.options.output === false) {
                return;
            }
            if (report) {
                outputTapables(report.timings.tapables);
                outputLoaders(report.timings.loaders);
                outputModules(report.dependencies, report.timings.modules);
            }
            if (bundler.webpack) {
                exports.outputWebpack(bundler.webpack);
            }
            if (bundler.esbuild) {
                exports.outputEsbuild(bundler.esbuild);
            }
            console.log();
        });
    },
};
