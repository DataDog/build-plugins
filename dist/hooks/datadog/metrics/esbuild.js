"use strict";
// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const helpers_1 = require("../../../helpers");
const helpers_2 = require("../helpers");
const path_1 = __importDefault(require("path"));
exports.getInputsDependencies = (list, moduleName, deps = new Set()) => {
    const module = list[moduleName];
    for (const dep of module.imports) {
        if (deps.has(dep.path)) {
            continue;
        }
        deps.add(dep.path);
        if (list[dep.path]) {
            exports.getInputsDependencies(list, dep.path, deps);
        }
    }
    return deps;
};
const getModulePath = (fullPath, context) => {
    const filePath = fullPath.replace('pnp:', '').replace(context, '');
    return helpers_1.getDisplayName(path_1.default.resolve(context, filePath), context);
};
// Get some indexed data to ease the metrics aggregation.
exports.getIndexed = (stats, context) => {
    const inputsDependencies = {};
    const outputsDependencies = {};
    const entryNames = new Map();
    if (Array.isArray(stats.entrypoints)) {
        // We don't have an indexed object as entry, so we can't get an entry name from it.
        for (const entry of stats.entrypoints) {
            const realEntry = getModulePath(entry, context);
            entryNames.set(realEntry, realEntry);
        }
    }
    else if (stats.entrypoints) {
        const entrypoints = stats.entrypoints ? Object.entries(stats.entrypoints) : [];
        for (const [entryName, entryPath] of entrypoints) {
            entryNames.set(getModulePath(entryPath, context), entryName);
        }
    }
    // First loop to index inputs dependencies.
    const outputs = stats.outputs ? Object.entries(stats.outputs) : [];
    for (const [outputName, output] of outputs) {
        if (output.entryPoint) {
            const entryName = entryNames.get(helpers_1.getDisplayName(output.entryPoint, context));
            const inputs = output.inputs ? Object.keys(output.inputs) : [];
            inputsDependencies[entryName] = new Set(inputs);
            outputsDependencies[entryName] = new Set([outputName]);
            for (const input of inputs) {
                if (stats.inputs[input]) {
                    const imports = stats.inputs[input].imports.map((imp) => imp.path);
                    inputsDependencies[entryName] = new Set([
                        ...inputsDependencies[entryName],
                        ...imports,
                    ]);
                }
            }
        }
    }
    // Second loop to index output dependencies.
    // Input dependencies are needed, hence the second loop.
    for (const [outputName, output] of outputs) {
        // Check which entry has generated this output.
        const inputs = output.inputs ? Object.keys(output.inputs) : [];
        for (const inputName of inputs) {
            for (const [entryName, entry] of Object.entries(inputsDependencies)) {
                if (entry.has(inputName)) {
                    outputsDependencies[entryName].add(outputName);
                }
            }
        }
    }
    return {
        inputsDependencies,
        outputsDependencies,
        entryNames,
    };
};
exports.formatEntryTag = (entryName, context) => {
    return `entryName:${helpers_1.getDisplayName(entryName, context)}`;
};
exports.getEntryTags = (module, indexed, context) => {
    const tags = [];
    const inputsDependencies = indexed.inputsDependencies
        ? Object.entries(indexed.inputsDependencies)
        : [];
    for (const [entryName, entryDeps] of inputsDependencies) {
        if (entryDeps.has(module)) {
            tags.push(exports.formatEntryTag(entryName, context));
        }
    }
    return tags;
};
exports.getModules = (stats, indexed, context) => {
    const metrics = [];
    const inputs = stats.inputs ? Object.entries(stats.inputs) : [];
    for (const [rawModuleName, module] of inputs) {
        const moduleName = helpers_1.getDisplayName(rawModuleName, context);
        const entryTags = exports.getEntryTags(rawModuleName, indexed, context);
        metrics.push({
            metric: 'module.size',
            type: 'size',
            value: module.bytes,
            tags: [`moduleName:${moduleName}`, `moduleType:${helpers_2.getType(moduleName)}`, ...entryTags],
        });
    }
    return metrics;
};
exports.getAssets = (stats, indexed, context) => {
    const outputs = stats.outputs ? Object.entries(stats.outputs) : [];
    return outputs.map(([rawAssetName, asset]) => {
        const assetName = helpers_1.getDisplayName(rawAssetName, context);
        const entryTags = Array.from(new Set(helpers_2.flattened(Object.keys(asset.inputs).map((modulePath) => exports.getEntryTags(modulePath, indexed, context)))));
        return {
            metric: 'assets.size',
            type: 'size',
            value: asset.bytes,
            tags: [`assetName:${assetName}`, `assetType:${helpers_2.getType(assetName)}`, ...entryTags],
        };
    });
};
exports.getEntries = (stats, indexed, context) => {
    const metrics = [];
    const outputs = stats.outputs ? Object.entries(stats.outputs) : [];
    for (const [, output] of outputs) {
        if (output.entryPoint) {
            const entryName = indexed.entryNames.get(getModulePath(output.entryPoint, context));
            if (entryName) {
                const inputs = exports.getInputsDependencies(stats.inputs, output.entryPoint);
                const tags = [exports.formatEntryTag(entryName, context)];
                metrics.push({
                    metric: 'entries.size',
                    type: 'size',
                    value: output.bytes,
                    tags,
                }, {
                    metric: 'entries.modules.count',
                    type: 'count',
                    value: inputs.size,
                    tags,
                }, {
                    metric: 'entries.assets.count',
                    type: 'count',
                    value: indexed.outputsDependencies[entryName].size,
                    tags,
                });
            }
        }
    }
    return metrics;
};
