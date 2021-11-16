import { EsbuildStats, EsbuildIndexedObject } from '../../../types';
import { Metric } from '../types';
import { getDisplayName } from '../../../helpers';
import { getType } from '../helpers';
import { Metafile } from 'esbuild';

export const getInputsDependencies = (
    list: Metafile['inputs'],
    moduleName: string,
    deps: Set<string> = new Set()
) => {
    const module = list[moduleName];
    for (const dep of module.imports) {
        deps.add(dep.path);
        if (list[dep.path]) {
            getInputsDependencies(list, dep.path, deps);
        }
    }

    return deps;
};

const getModulePath = (fullPath: string, context: string): string => {
    return getDisplayName(require.resolve(fullPath), context);
};

// Get some indexed data to ease the metrics aggregation.
export const getIndexed = (stats: EsbuildStats, context: string): EsbuildIndexedObject => {
    const inputsDependencies: { [key: string]: Set<string> } = {};
    const outputsDependencies: { [key: string]: Set<string> } = {};

    const entryNames = new Map();
    if (Array.isArray(stats.entrypoints)) {
        // We don't have an indexed object as entry, so we can't get an entry name from it.
        for (const entry of stats.entrypoints) {
            const realEntry = getModulePath(entry, context);
            entryNames.set(realEntry, realEntry);
        }
    } else if (stats.entrypoints) {
        for (const [entryName, entryPath] of Object.entries(stats.entrypoints)) {
            entryNames.set(getModulePath(entryPath, context), entryName);
        }
    }

    // First loop to index inputs dependencies.
    for (const [outputName, output] of Object.entries(stats.outputs)) {
        if (output.entryPoint) {
            const entryName = entryNames.get(getDisplayName(output.entryPoint, context));
            inputsDependencies[entryName] = new Set(Object.keys(output.inputs));
            outputsDependencies[entryName] = new Set([outputName]);
            for (const input of Object.keys(output.inputs)) {
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
    for (const [outputName, output] of Object.entries(stats.outputs)) {
        // Check which entry has generated this output.
        for (const inputName of Object.keys(output.inputs)) {
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
    for (const [entryName, entryDeps] of Object.entries(indexed.inputsDependencies)) {
        if (entryDeps.has(module)) {
            tags.push(formatEntryTag(entryName, context));
        }
    }
    return tags;
};

export const getModules = (
    stats: EsbuildStats,
    indexed: EsbuildIndexedObject,
    context: string
): Metric[] => {
    const metrics: Metric[] = [];

    for (const [rawModuleName, module] of Object.entries(stats.inputs)) {
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
    context: string
): Metric[] => {
    return Object.entries(stats.outputs).map(([rawAssetName, asset]) => {
        const assetName = getDisplayName(rawAssetName, context);
        const entryTags = Array.from(
            new Set(
                Object.keys(asset.inputs)
                    .map((modulePath) => getEntryTags(modulePath, indexed, context))
                    .flat()
            )
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
    context: string
): Metric[] => {
    const metrics: Metric[] = [];
    for (const [, output] of Object.entries(stats.outputs)) {
        if (output.entryPoint) {
            const entryName = indexed.entryNames.get(
                getModulePath(`${context}/${output.entryPoint}`, context)
            );
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
                    }
                );
            }
        }
    }
    return metrics;
};
