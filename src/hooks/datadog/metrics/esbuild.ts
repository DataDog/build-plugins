import { EsbuildStats, EsbuildIndexedObject } from '../../../types';
import { Metric } from '../types';
import { getDisplayName } from '../../../helpers';
import { getType } from '../helpers';
import { ImportKind, Metafile } from 'esbuild';

type EsbuildModule = {
    bytes: number;
    imports: {
        path: string;
        kind: ImportKind;
    }[];
};

export const getOutputsDependencies = (
    list: Metafile['outputs'],
    moduleName: string,
    deps: Set<string> = new Set()
) => {
    const module = list[moduleName];
    if (!module) {
        console.log('Couldnt find module', moduleName);
        return deps;
    }
    for (const depPath of Object.keys(module.inputs)) {
        deps.add(depPath);
        if (list[depPath]) {
            getOutputsDependencies(list, depPath, deps);
        }
    }

    return deps;
};

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

const getModulePath = (fullPath:string, context: string): string => {
    return getDisplayName(require.resolve(fullPath), context);
}

export const getIndexed = (stats: EsbuildStats, context: string): EsbuildIndexedObject => {
    const entriesDependencies: { [key: string]: Set<string> } = {};

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
        };
    }

    for (const [outputName, output] of Object.entries(stats.outputs)) {
        if (output.entryPoint) {
            const entryName = entryNames.get(getDisplayName(output.entryPoint, context));
            entriesDependencies[entryName] = new Set(Object.keys(output.inputs));
        }
    }

    return {
        entriesDependencies,
    };
};

export const formatEntryTag = (entryName: string, context: string): string => {
    return `entryName:${getDisplayName(entryName, context)}`;
};

export const getEntryTags = (module: string, indexed: EsbuildIndexedObject, context: string) => {
    const tags: string[] = [];
    for (const [entryName, entryDeps] of Object.entries(indexed.entriesDependencies)) {
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
        console.log('module.size', entryTags);
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
        const entryTags = Array.from(new Set(Object.keys(asset.inputs).map(modulePath => getEntryTags(modulePath, indexed, context)).flat()));
        console.log('assets.size', entryTags);
        return {
            metric: 'assets.size',
            type: 'size',
            value: asset.bytes,
            tags: [`assetName:${assetName}`, `assetType:${getType(assetName)}`, ...entryTags],
        };
    });
};

export const getEntries = (stats: EsbuildStats, context: string): Metric[] => {
    const metrics: Metric[] = [];
    for (const [, output] of Object.entries(stats.outputs)) {
        if (output.entryPoint) {
            const entryName = getDisplayName(output.entryPoint, context);
            const inputs = getInputsDependencies(stats.inputs, output.entryPoint);
            const outputs = getOutputsDependencies(stats.outputs, output.entryPoint);
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
                    value: outputs.size,
                    tags,
                }
            );
        }
    }
    return metrics;
};
