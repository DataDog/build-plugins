// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { EsbuildStats, EsbuildIndexedObject } from '@datadog/build-plugins-core/types';
import { Metric } from '../types';
import { getDisplayName } from '@datadog/build-plugins-core/helpers';
import { flattened, getType } from '../helpers';
import { Metafile } from 'esbuild';
import path from 'path';

export const getInputsDependencies = (
    list: Metafile['inputs'],
    moduleName: string,
    deps: Set<string> = new Set(),
) => {
    const module = list[moduleName];
    for (const dep of module.imports) {
        if (deps.has(dep.path)) {
            continue;
        }
        deps.add(dep.path);
        if (list[dep.path]) {
            getInputsDependencies(list, dep.path, deps);
        }
    }

    return deps;
};

const getModulePath = (fullPath: string, context: string): string => {
    const filePath = fullPath.replace('pnp:', '').replace(context, '');
    return getDisplayName(path.resolve(context, filePath), context);
};

// Get some indexed data to ease the metrics aggregation.
export const getIndexed = (stats: EsbuildStats, context: string): EsbuildIndexedObject => {
    const inputsDependencies: { [key: string]: Set<string> } = {};
    const outputsDependencies: { [key: string]: Set<string> } = {};

    const entryNames = new Map();
    if (Array.isArray(stats.entrypoints)) {
        // We don't have an indexed object as entry, so we can't get an entry name from it.
        for (const entry of stats.entrypoints) {
            const fullPath = typeof entry === 'object' ? entry.in : entry;
            const realEntry = getModulePath(fullPath, context);
            entryNames.set(realEntry, realEntry);
        }
    } else if (stats.entrypoints) {
        const entrypoints = stats.entrypoints ? Object.entries(stats.entrypoints) : [];
        for (const [entryName, entryPath] of entrypoints) {
            entryNames.set(getModulePath(entryPath, context), entryName);
        }
    }

    // First loop to index inputs dependencies.
    const outputs = stats.outputs ? Object.entries(stats.outputs) : [];
    for (const [outputName, output] of outputs) {
        if (output.entryPoint) {
            const entryName = entryNames.get(getDisplayName(output.entryPoint, context));
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

export const formatEntryTag = (entryName: string, context: string): string => {
    return `entryName:${getDisplayName(entryName, context)}`;
};

export const getEntryTags = (module: string, indexed: EsbuildIndexedObject, context: string) => {
    const tags: string[] = [];
    const inputsDependencies = indexed.inputsDependencies
        ? Object.entries(indexed.inputsDependencies)
        : [];
    for (const [entryName, entryDeps] of inputsDependencies) {
        if (entryDeps.has(module)) {
            tags.push(formatEntryTag(entryName, context));
        }
    }
    return tags;
};

export const getModules = (
    stats: EsbuildStats,
    indexed: EsbuildIndexedObject,
    context: string,
): Metric[] => {
    const metrics: Metric[] = [];

    const inputs = stats.inputs ? Object.entries(stats.inputs) : [];
    for (const [rawModuleName, module] of inputs) {
        const moduleName = getDisplayName(rawModuleName, context);
        const entryTags = getEntryTags(rawModuleName, indexed, context);

        metrics.push({
            metric: 'module.size',
            type: 'size',
            value: module.bytes,
            tags: [`moduleName:${moduleName}`, `moduleType:${getType(moduleName)}`, ...entryTags],
        });
    }

    return metrics;
};

export const getAssets = (
    stats: EsbuildStats,
    indexed: EsbuildIndexedObject,
    context: string,
): Metric[] => {
    const outputs = stats.outputs ? Object.entries(stats.outputs) : [];
    return outputs.map(([rawAssetName, asset]) => {
        const assetName = getDisplayName(rawAssetName, context);
        const entryTags = Array.from(
            new Set(
                flattened(
                    Object.keys(asset.inputs).map((modulePath) =>
                        getEntryTags(modulePath, indexed, context),
                    ),
                ),
            ),
        );

        return {
            metric: 'assets.size',
            type: 'size',
            value: asset.bytes,
            tags: [`assetName:${assetName}`, `assetType:${getType(assetName)}`, ...entryTags],
        };
    });
};

export const getEntries = (
    stats: EsbuildStats,
    indexed: EsbuildIndexedObject,
    context: string,
): Metric[] => {
    const metrics: Metric[] = [];
    const outputs = stats.outputs ? Object.entries(stats.outputs) : [];
    for (const [, output] of outputs) {
        if (output.entryPoint) {
            const entryName = indexed.entryNames.get(getModulePath(output.entryPoint, context));
            if (entryName) {
                const inputs = getInputsDependencies(stats.inputs, output.entryPoint);
                const tags = [formatEntryTag(entryName, context)];

                metrics.push(
                    {
                        metric: 'entries.size',
                        type: 'size',
                        value: output.bytes,
                        tags,
                    },
                    {
                        metric: 'entries.modules.count',
                        type: 'count',
                        value: inputs.size,
                        tags,
                    },
                    {
                        metric: 'entries.assets.count',
                        type: 'count',
                        value: indexed.outputsDependencies[entryName].size,
                        tags,
                    },
                );
            }
        }
    }
    return metrics;
};
