// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BuildReport, TimingsMap } from '@dd/core/types';
import type { Metric } from '@dd/metrics-plugin/types';

export const getUniversalMetrics = (buildReport: BuildReport, timestamp: number): Set<Metric> => {
    const metrics: Set<Metric> = new Set();

    const inputs = buildReport.inputs || [];
    const outputs = buildReport.outputs || [];
    const entries = buildReport.entries || [];
    const nbWarnings = buildReport.warnings.length;
    const nbErrors = buildReport.errors.length;
    const duration = buildReport.duration;

    // Create some indexes to speed up the process.
    const entriesPerInput = new Map<string, string[]>();
    const assetsPerInput = new Map<string, string[]>();
    const entriesPerAsset = new Map<string, string[]>();

    for (const entry of entries) {
        for (const input of entry.inputs) {
            if (!entriesPerInput.has(input.filepath)) {
                entriesPerInput.set(input.filepath, []);
            }
            entriesPerInput.get(input.filepath)!.push(entry.name);
        }
        for (const output of entry.outputs) {
            const cleanAssetName = output.filepath.replace(/\.map$/, '');
            if (!entriesPerAsset.has(cleanAssetName)) {
                entriesPerAsset.set(cleanAssetName, []);
            }
            entriesPerAsset.get(cleanAssetName)!.push(entry.name);
        }
    }

    for (const output of outputs) {
        for (const input of output.inputs) {
            if (!assetsPerInput.has(input.filepath)) {
                assetsPerInput.set(input.filepath, []);
            }
            assetsPerInput.get(input.filepath)!.push(output.name);
        }
    }

    // Counts
    metrics
        .add({
            metric: 'assets.count',
            type: 'count',
            points: [[timestamp, outputs.length]],
            tags: [],
        })
        .add({
            metric: 'entries.count',
            type: 'count',
            points: [[timestamp, entries.length]],
            tags: [],
        })
        .add({
            metric: 'errors.count',
            type: 'count',
            points: [[timestamp, nbErrors]],
            tags: [],
        })
        .add({
            metric: 'modules.count',
            type: 'count',
            points: [[timestamp, inputs.length]],
            tags: [],
        })
        .add({
            metric: 'warnings.count',
            type: 'count',
            points: [[timestamp, nbWarnings]],
            tags: [],
        });

    if (duration) {
        metrics.add({
            metric: 'compilation.duration',
            type: 'duration',
            points: [[timestamp, duration]],
            tags: [],
        });
    }

    // Modules
    for (const input of inputs) {
        const tags = [`moduleName:${input.name}`, `moduleType:${input.type}`];
        if (entriesPerInput.has(input.filepath)) {
            tags.push(
                ...entriesPerInput
                    .get(input.filepath)!
                    .map((entryName) => `entryName:${entryName}`),
            );
        }

        if (assetsPerInput.has(input.filepath)) {
            tags.push(
                ...assetsPerInput.get(input.filepath)!.map((assetName) => `assetName:${assetName}`),
            );
        }
        metrics
            .add({
                metric: 'modules.size',
                type: 'size',
                points: [[timestamp, input.size]],
                tags,
            })
            .add({
                metric: 'modules.dependencies',
                type: 'count',
                points: [[timestamp, input.dependencies.size]],
                tags,
            })
            .add({
                metric: 'modules.dependents',
                type: 'count',
                points: [[timestamp, input.dependents.size]],
                tags,
            });
    }

    // Assets
    for (const output of outputs) {
        const tags = [`assetName:${output.name}`, `assetType:${output.type}`];
        const cleanAssetName = output.filepath.replace(/\.map$/, '');
        if (entriesPerAsset.has(cleanAssetName)) {
            tags.push(
                ...entriesPerAsset
                    .get(cleanAssetName)!
                    .map((entryName) => `entryName:${entryName}`),
            );
        }
        metrics
            .add({
                metric: 'assets.size',
                type: 'size',
                points: [[timestamp, output.size]],
                tags,
            })
            .add({
                metric: 'assets.modules.count',
                type: 'count',
                points: [[timestamp, output.inputs.length]],
                tags,
            });
    }

    // Entries
    for (const entry of entries) {
        const tags = [`entryName:${entry.name}`];
        metrics
            .add({
                metric: 'entries.size',
                type: 'size',
                points: [[timestamp, entry.size]],
                tags,
            })
            .add({
                metric: 'entries.modules.count',
                type: 'count',
                points: [[timestamp, entry.inputs.length]],
                tags,
            })
            .add({
                metric: 'entries.assets.count',
                type: 'count',
                points: [[timestamp, entry.outputs.length]],
                tags,
            });
    }

    return metrics;
};

export const getPluginMetrics = (
    plugins: TimingsMap | undefined,
    timestamp: number,
): Set<Metric> => {
    const metrics: Set<Metric> = new Set();

    if (!plugins) {
        return metrics;
    }

    metrics.add({
        metric: 'plugins.count',
        type: 'count',
        points: [[timestamp, plugins.size]],
        tags: [],
    });

    for (const plugin of plugins.values()) {
        let pluginDuration = 0;
        let pluginCount = 0;

        for (const hook of Object.values(plugin.events)) {
            let hookDuration = 0;
            pluginCount += hook.values.length;
            for (const v of hook.values) {
                const duration = v.end - v.start;
                hookDuration += duration;
                pluginDuration += duration;
            }
            metrics
                .add({
                    metric: 'plugins.hooks.duration',
                    type: 'duration',
                    points: [[timestamp, hookDuration]],
                    tags: [`pluginName:${plugin.name}`, `hookName:${hook.name}`],
                })
                .add({
                    metric: 'plugins.hooks.increment',
                    type: 'count',
                    points: [[timestamp, hook.values.length]],
                    tags: [`pluginName:${plugin.name}`, `hookName:${hook.name}`],
                });
        }

        metrics
            .add({
                metric: 'plugins.duration',
                type: 'duration',
                points: [[timestamp, pluginDuration]],
                tags: [`pluginName:${plugin.name}`],
            })
            .add({
                metric: 'plugins.increment',
                type: 'count',
                points: [[timestamp, pluginCount]],
                tags: [`pluginName:${plugin.name}`],
            });
    }

    return metrics;
};

export const getLoaderMetrics = (
    loaders: TimingsMap | undefined,
    timestamp: number,
): Set<Metric> => {
    const metrics: Set<Metric> = new Set();

    if (!loaders) {
        return metrics;
    }

    metrics.add({
        metric: 'loaders.count',
        type: 'count',
        points: [[timestamp, loaders.size]],
        tags: [],
    });

    for (const loader of loaders.values()) {
        metrics
            .add({
                metric: 'loaders.duration',
                type: 'duration',
                points: [[timestamp, loader.duration]],
                tags: [`loaderName:${loader.name}`],
            })
            .add({
                metric: 'loaders.increment',
                type: 'count',
                points: [[timestamp, loader.increment]],
                tags: [`loaderName:${loader.name}`],
            });
    }

    return metrics;
};
