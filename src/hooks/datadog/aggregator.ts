// Unless explicitly stated otherwise all files in this repository are licensed
// under the MIT License.
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
    TappableTimings,
    ResultLoaders,
    Module,
    LocalModules,
    Asset,
} from '../../types';

import { getMetric } from './helpers';
import { Metric, MetricToSend, GetMetricsOptions } from './types';

const getType = (name: string) => name.split('.').pop();

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
        value: Object.keys(timings.tappables).length,
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
    modules
        .map((m) => [
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
        .flat(2);

const getPlugins = (plugins: TappableTimings): Metric[] => {
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

const getLoaders = (loaders: ResultLoaders): Metric[] => {
    return Object.values(loaders)
        .map((loader) => [
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
        .flat(Infinity);
};

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

const getModules = (modules: Module[], dependencies: LocalModules, context: string): Metric[] => {
    const modulesPerName: { [key: string]: Module } = {};
    for (const module of modules) {
        modulesPerName[formatModuleName(module.name, context)] = module;
    }
    const clonedModules: Module[] = [...modules];
    return clonedModules
        .map((module) => {
            // Modules are sometimes registered with their loader.
            if (module.name.includes('!')) {
                return [];
            }
            const moduleName = getDisplayName(module.name, context);
            const tree = Array.from(findDependencies(module.name, dependencies)).map(
                (dependencyName) => modulesPerName[dependencyName]
            );

            const treeSize = tree.reduce((previous, current) => {
                return previous + current.size;
            }, 0);
            return [
                {
                    metric: 'modules.size',
                    type: 'size',
                    value: module.size,
                    tags: [`moduleName:${moduleName}`, `moduleType:${getType(moduleName)}`],
                },
                {
                    metric: 'modules.tree.size',
                    type: 'size',
                    value: treeSize,
                    tags: [`moduleName:${moduleName}`, `moduleType:${getType(moduleName)}`],
                },
                {
                    metric: 'modules.tree.count',
                    type: 'count',
                    value: tree.length,
                    tags: [`moduleName:${moduleName}`, `moduleType:${getType(moduleName)}`],
                },
            ];
        })
        .flat(Infinity);
};

const getChunks = (chunks: Chunk[]): Metric[] => {
    return chunks
        .map((chunk) => {
            const chunkName = chunk.names.length ? chunk.names.join(' ') : chunk.id;
            return [
                {
                    metric: 'chunks.size',
                    type: 'size',
                    value: chunk.size,
                    tags: [`chunkName:${chunkName}`],
                },
                {
                    metric: 'chunks.modules.count',
                    type: 'count',
                    value: chunk.modules.length,
                    tags: [`chunkName:${chunkName}`],
                },
            ];
        })
        .flat(Infinity);
};

const getAssets = (assets: Asset[]): Metric[] => {
    return assets.map((asset) => {
        const assetName = asset.name;
        return {
            metric: 'assets.size',
            type: 'size',
            value: asset.size,
            tags: [`assetName:${assetName}`, `assetType:${getType(assetName)}`],
        };
    });
};

const getEntries = (stats: StatsJson): Metric[] => {
    return Object.keys(stats.entrypoints)
        .map((entryName) => {
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
        .flat(Infinity);
};

export const getMetrics = async (
    report: Report,
    stats: Stats,
    opts: GetMetricsOptions
): Promise<MetricToSend[]> => {
    // TODO use context's stats
    const statsJson = stats.toJson({ children: false });
    const { timings, dependencies } = report;
    const metrics: Metric[] = [];

    metrics.push(...getGenerals(timings, statsJson));
    metrics.push(...getDependencies(Object.values(dependencies)));
    metrics.push(...getPlugins(timings.tappables));
    metrics.push(...getLoaders(timings.loaders));
    metrics.push(...getModules(statsJson.modules, dependencies, opts.context));
    metrics.push(...getChunks(statsJson.chunks));
    metrics.push(...getAssets(statsJson.assets));
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
