// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext } from '@dd/core/types';
import type { Metafile } from 'esbuild';
import path from 'path';

import type { EsbuildIndexedObject, Metric } from '../../types';
import { getDisplayName, flattened, getType } from '../helpers';

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

const getModulePath = (fullPath: string, cwd: string): string => {
    let resolvedPath = fullPath;
    try {
        resolvedPath = require.resolve(fullPath);
    } catch (e) {
        // No problem, we keep the initial path.
    }
    const filePath = resolvedPath.replace('pnp:', '').replace(cwd, '');
    return getDisplayName(path.resolve(cwd, filePath), cwd);
};

// Get some indexed data to ease the metrics aggregation.
export const getIndexed = (
    stats: Metafile,
    globalContext: GlobalContext,
    cwd: string,
): EsbuildIndexedObject => {
    const inputsDependencies: { [key: string]: Set<string> } = {};
    const outputsDependencies: { [key: string]: Set<string> } = {};

    const entryNames = new Map();
    if (globalContext.build.entries?.length) {
        for (const entry of globalContext.build.entries) {
            entryNames.set(getModulePath(entry.filepath, cwd), entry.name);
        }
    }

    // First loop to index inputs dependencies.
    const outputs = stats.outputs ? Object.entries(stats.outputs) : [];
    for (const [outputName, output] of outputs) {
        if (output.entryPoint) {
            const entryName = entryNames.get(getDisplayName(output.entryPoint, cwd));
            const inputs = output.inputs ? Object.keys(output.inputs) : [];
            inputsDependencies[entryName] = new Set(inputs);
            outputsDependencies[entryName] =
                outputsDependencies[entryName] || new Set([outputName]);
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

export const formatEntryTag = (entryName: string, cwd: string): string => {
    return `entryName:${getDisplayName(entryName, cwd)}`;
};

export const getEntryTags = (module: string, indexed: EsbuildIndexedObject, cwd: string) => {
    const tags: string[] = [];
    const inputsDependencies = indexed.inputsDependencies
        ? Object.entries(indexed.inputsDependencies)
        : [];

    for (const [entryName, entryDeps] of inputsDependencies) {
        if (entryDeps.has(module)) {
            tags.push(formatEntryTag(entryName, cwd));
        }
    }

    return tags;
};

export const getModules = (
    stats: Metafile,
    indexed: EsbuildIndexedObject,
    cwd: string,
): Metric[] => {
    const metrics: Metric[] = [];

    const inputs = stats.inputs ? Object.entries(stats.inputs) : [];
    for (const [rawModuleName, module] of inputs) {
        const moduleName = getDisplayName(rawModuleName, cwd);
        const entryTags = getEntryTags(rawModuleName, indexed, cwd);

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
    stats: Metafile,
    indexed: EsbuildIndexedObject,
    cwd: string,
): Metric[] => {
    const outputs = stats.outputs ? Object.entries(stats.outputs) : [];
    return outputs.map(([rawAssetName, asset]) => {
        const assetName = getDisplayName(rawAssetName, cwd);
        const entryTags = Array.from(
            new Set(
                flattened(
                    Object.keys(asset.inputs).map((modulePath) =>
                        getEntryTags(modulePath, indexed, cwd),
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
    stats: Metafile,
    indexed: EsbuildIndexedObject,
    cwd: string,
): Metric[] => {
    const metrics: Metric[] = [];
    const outputs = stats.outputs ? Object.entries(stats.outputs) : [];
    for (const [, output] of outputs) {
        if (output.entryPoint) {
            const entryName = indexed.entryNames.get(getModulePath(output.entryPoint, cwd));
            if (entryName) {
                const inputs = getInputsDependencies(stats.inputs, output.entryPoint);
                const tags = [formatEntryTag(entryName, cwd)];
                const assets = indexed.outputsDependencies[entryName] || new Set();
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
                        value: assets.size,
                        tags,
                    },
                );
            }
        }
    }
    return metrics;
};
