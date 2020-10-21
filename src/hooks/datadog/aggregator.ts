// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { formatModuleName, getDisplayName } from '../../helpers';
import {
    Chunk,
    Report,
    StatsJson,
    Stats,
    TimingsReport,
    LocalModule,
    TapableTimings,
    ResultLoaders,
    Module,
    LocalModules,
    Entry,
} from '../../types';
import { getMetric } from './helpers';
import { Metric, MetricToSend, GetMetricsOptions } from './types';

const flattened = (arr: any[]) => [].concat(...arr);

const getType = (name: string) => name.indexOf('.') >= 0 ? name.split('.').pop() : 'unknown';

const getGenerals = (timings: TimingsReport, stats: StatsJson): Metric[] => [
    {
        metric: 'modules.count',
        type: 'count',
        value: stats.modules.length,
        tags: [],
    },
    {
        metric: 'chunks.count',
        type: 'count',
        value: stats.chunks.length,
        tags: [],
    },
    {
        metric: 'assets.count',
        type: 'count',
        value: stats.assets.length,
        tags: [],
    },
    {
        metric: 'plugins.count',
        type: 'count',
        value: Object.keys(timings.tapables).length,
        tags: [],
    },
    {
        metric: 'loaders.count',
        type: 'count',
        value: Object.keys(timings.loaders).length,
        tags: [],
    },
    {
        metric: 'warnings.count',
        type: 'count',
        value: stats.warnings.length,
        tags: [],
    },
    {
        metric: 'errors.count',
        type: 'count',
        value: stats.errors.length,
        tags: [],
    },
    {
        metric: 'entries.count',
        type: 'count',
        value: Object.keys(stats.entrypoints).length,
        tags: [],
    },
    {
        metric: 'compilation.duration',
        type: 'duration',
        value: stats.time,
        tags: [],
    },
];

const getDependencies = (modules: LocalModule[]): Metric[] =>
    flattened(
        modules.map((m) => [
            {
                metric: 'modules.dependencies',
                type: 'count',
                value: m.dependencies.length,
                tags: [`moduleName:${m.name}`, `moduleType:${getType(m.name)}`],
            },
            {
                metric: 'modules.dependents',
                type: 'count',
                value: m.dependents.length,
                tags: [`moduleName:${m.name}`, `moduleType:${getType(m.name)}`],
            },
        ])
    );

const getPlugins = (plugins: TapableTimings): Metric[] => {
    const metrics: Metric[] = [];
    for (const plugin of Object.values(plugins)) {
        let pluginDuration = 0;
        let pluginCount = 0;

        for (const hook of Object.values(plugin.hooks)) {
            let hookDuration = 0;
            pluginCount += hook.values.length;
            for (const v of hook.values) {
                const duration = v.end - v.start;
                hookDuration += duration;
                pluginDuration += duration;
            }
            metrics.push(
                {
                    metric: 'plugins.hooks.duration',
                    type: 'duration',
                    value: hookDuration,
                    tags: [`pluginName:${plugin.name}`, `hookName:${hook.name}`],
                },
                {
                    metric: 'plugins.hooks.increment',
                    type: 'count',
                    value: hook.values.length,
                    tags: [`pluginName:${plugin.name}`, `hookName:${hook.name}`],
                }
            );
        }

        metrics.push(
            {
                metric: 'plugins.duration',
                type: 'duration',
                value: pluginDuration,
                tags: [`pluginName:${plugin.name}`],
            },
            {
                metric: 'plugins.increment',
                type: 'count',
                value: pluginCount,
                tags: [`pluginName:${plugin.name}`],
            }
        );
    }

    return metrics;
};

const getLoaders = (loaders: ResultLoaders): Metric[] =>
    flattened(
        Object.values(loaders).map((loader) => [
            {
                metric: 'loaders.duration',
                type: 'duration',
                value: loader.duration,
                tags: [`loaderName:${loader.name}`],
            },
            {
                metric: 'loaders.increment',
                type: 'count',
                value: loader.increment,
                tags: [`loaderName:${loader.name}`],
            },
        ])
    );

// Register the imported tree of a module
const findDependencies = (
    moduleName: string,
    dependencies: LocalModules,
    moduleDeps: Set<string> = new Set()
): Set<string> => {
    if (!dependencies[moduleName]) {
        return moduleDeps;
    }
    for (const dependency of dependencies[moduleName].dependencies) {
        if (!moduleDeps.has(dependency)) {
            moduleDeps.add(dependency);
            findDependencies(dependency, dependencies, moduleDeps);
        }
    }
    return moduleDeps;
};

export const getFromId = (coll: any[], id: string) => coll.find((c) => c.id === id);

export const getEntriesFromChunk = (
    stats: StatsJson,
    chunk: Chunk,
    parentEntries: Set<string> = new Set(),
    parentChunks: Set<string> = new Set()
): Set<string> => {
    const entry = Object.entries(stats.entrypoints).find(([name, e]: [string, Entry]) =>
        e.chunks.includes(chunk.id)
    );
    if (entry) {
        parentEntries.add(entry[0]);
    }
    // Escape cyclic dependencies.
    if (parentChunks.has(chunk.id)) {
        // console.log(`Already have ${chunk.id}`);
        return parentEntries;
    }
    // console.log(`New chunk ${chunk.id}`);
    parentChunks.add(chunk.id);
    chunk.parents.forEach((p: string) => {
        const parentChunk = getFromId(stats.chunks, p);
        if (parentChunk) {
            getEntriesFromChunk(stats, parentChunk, parentEntries, parentChunks);
        }
    });
    return parentEntries;
};

export const getEntryTags = (entries: Set<string>): string[] =>
    Array.from(entries).map((e) => `entryName:${e}`);
export const getChunkTags = (chunks: Chunk[]): string[] =>
    chunks
        .map((c) => {
            if (c.names && c.names.length) {
                return c.names.map((n) => `chunkName:${n}`);
            }
        })
        .filter((c) => c)
        .flat();

export const getModules = (
    stats: StatsJson,
    dependencies: LocalModules,
    context: string
): Metric[] => {
    const modules = stats.modules;
    const modulesPerName: { [key: string]: Module } = {};
    for (const module of modules) {
        modulesPerName[formatModuleName(module.name, context)] = module;
    }
    const clonedModules: Module[] = [...modules];
    return flattened(
        clonedModules
        .filter((module) => /^webpack\/runtime/.test(module.name))
        .map((module) => {
            // Modules are sometimes registered with their loader.
            if (module.name.includes('!')) {
                return [];
            }

            const chunks = module.chunks.map((c) => getFromId(stats.chunks, c));
            const entries: Set<string> = new Set();
            for (const chunk of chunks) {
                getEntriesFromChunk(stats, chunk, entries);
            }
            const chunkTags = getChunkTags(chunks);
            const entryTags = getEntryTags(entries);
            const moduleName = getDisplayName(module.name, context);

            const tree = Array.from(findDependencies(module.name, dependencies)).map(
                (dependencyName) => modulesPerName[dependencyName]
            );

            const treeSize = tree.reduce((previous, current) => {
                return previous + (current ? current.size : 0);
            }, 0);
            return [
                {
                    metric: 'modules.size',
                    type: 'size',
                    value: module.size,
                    tags: [
                        `moduleName:${moduleName}`,
                        `moduleType:${getType(moduleName)}`,
                        ...entryTags,
                        ...chunkTags,
                    ],
                },
                {
                    metric: 'modules.tree.size',
                    type: 'size',
                    value: treeSize,
                    tags: [
                        `moduleName:${moduleName}`,
                        `moduleType:${getType(moduleName)}`,
                        ...entryTags,
                        ...chunkTags,
                    ],
                },
                {
                    metric: 'modules.tree.count',
                    type: 'count',
                    value: tree.length,
                    tags: [
                        `moduleName:${moduleName}`,
                        `moduleType:${getType(moduleName)}`,
                        ...entryTags,
                        ...chunkTags,
                    ],
                },
            ];
        })
    );
};

// Find in entries.chunks
export const getChunks = (stats: StatsJson): Metric[] => {
    const chunks = stats.chunks;

    return flattened(
        chunks.map((chunk) => {
            const entryTags = getEntryTags(getEntriesFromChunk(stats, chunk));
            const chunkName = chunk.names.length ? chunk.names.join(' ') : chunk.id;

            return [
                {
                    metric: 'chunks.size',
                    type: 'size',
                    value: chunk.size,
                    tags: [`chunkName:${chunkName}`, ...entryTags],
                },
                {
                    metric: 'chunks.modules.count',
                    type: 'count',
                    value: chunk.modules.length,
                    tags: [`chunkName:${chunkName}`, ...entryTags],
                },
            ];
        })
    );
};

export const getAssets = (stats: StatsJson): Metric[] => {
    const assets = stats.assets;
    return assets.map((asset) => {
        const chunks = asset.chunks.map((c) => getFromId(stats.chunks, c));
        const entries: Set<string> = new Set();
        for (const chunk of chunks) {
            getEntriesFromChunk(stats, chunk, entries);
        }
        const chunkTags = getChunkTags(chunks);
        const entryTags = getEntryTags(entries);
        const assetName = asset.name;

        return {
            metric: 'assets.size',
            type: 'size',
            value: asset.size,
            tags: [
                `assetName:${assetName}`,
                `assetType:${getType(assetName)}`,
                ...chunkTags,
                ...entryTags,
            ],
        };
    });
};

export const getEntries = (stats: StatsJson): Metric[] =>
    flattened(
        Object.keys(stats.entrypoints).map((entryName) => {
            const entry = stats.entrypoints[entryName];
            const chunks = entry.chunks.map(
                (chunkId) => stats.chunks.find((chunk) => chunk.id === chunkId)!
            );
            return [
                {
                    metric: 'entries.size',
                    type: 'size',
                    value: chunks.reduce(
                        (previous: number, current: Chunk) => previous + current.size,
                        0
                    ),
                    tags: [`entryName:${entryName}`],
                },
                {
                    metric: 'entries.chunks.count',
                    type: 'count',
                    value: chunks.length,
                    tags: [`entryName:${entryName}`],
                },
                {
                    metric: 'entries.modules.count',
                    type: 'count',
                    value: chunks.reduce(
                        (previous: number, current: Chunk) => previous + current.modules.length,
                        0
                    ),
                    tags: [`entryName:${entryName}`],
                },
                {
                    metric: 'entries.assets.count',
                    type: 'count',
                    value: chunks.reduce(
                        (previous: number, current: Chunk) => previous + current.files.length,
                        0
                    ),
                    tags: [`entryName:${entryName}`],
                },
            ];
        })
    );

export const getMetrics = (
    report: Report,
    stats: Stats,
    opts: GetMetricsOptions
): MetricToSend[] => {
    const statsJson = stats.toJson({ children: false });
    const { timings, dependencies } = report;
    const metrics: Metric[] = [];

    metrics.push(...getGenerals(timings, statsJson));
    metrics.push(...getDependencies(Object.values(dependencies)));
    metrics.push(...getPlugins(timings.tapables));
    metrics.push(...getLoaders(timings.loaders));
    metrics.push(...getModules(statsJson, dependencies, opts.context));
    metrics.push(...getChunks(statsJson));
    metrics.push(...getAssets(statsJson));
    metrics.push(...getEntries(statsJson));

    // Format metrics to be DD ready and apply filters
    const metricsToSend: MetricToSend[] = metrics
        .map((m) => {
            let metric: Metric | null = m;
            if (opts.filters.length) {
                for (const filter of opts.filters) {
                    // Could have been filtered out by an early filter.
                    if (metric) {
                        metric = filter(metric);
                    }
                }
            }
            return metric ? getMetric(metric, opts) : null;
        })
        .filter((m) => m !== null) as MetricToSend[];

    return metricsToSend;
};
