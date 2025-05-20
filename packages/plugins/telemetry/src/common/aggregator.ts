// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext } from '@dd/core/types';
import type { Metric, MetricToSend, OptionsDD, Report } from '@dd/telemetry-plugin/types';

import { getMetric } from './helpers';
import { addPluginMetrics, addLoaderMetrics } from './metrics/common';

const addUniversalMetrics = (globalContext: GlobalContext, metrics: Set<Metric>) => {
    const inputs = globalContext.build.inputs || [];
    const outputs = globalContext.build.outputs || [];
    const entries = globalContext.build.entries || [];
    const nbWarnings = globalContext.build.warnings.length;
    const nbErrors = globalContext.build.errors.length;
    const duration = globalContext.build.duration;

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
            value: outputs.length,
            tags: [],
        })
        .add({
            metric: 'entries.count',
            type: 'count',
            value: entries.length,
            tags: [],
        })
        .add({
            metric: 'errors.count',
            type: 'count',
            value: nbErrors,
            tags: [],
        })
        .add({
            metric: 'modules.count',
            type: 'count',
            value: inputs.length,
            tags: [],
        })
        .add({
            metric: 'warnings.count',
            type: 'count',
            value: nbWarnings,
            tags: [],
        });

    if (duration) {
        metrics.add({
            metric: 'compilation.duration',
            type: 'duration',
            value: duration,
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
                value: input.size,
                tags,
            })
            .add({
                metric: 'modules.dependencies',
                type: 'count',
                value: input.dependencies.size,
                tags,
            })
            .add({
                metric: 'modules.dependents',
                type: 'count',
                value: input.dependents.size,
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
                value: output.size,
                tags,
            })
            .add({
                metric: 'assets.modules.count',
                type: 'count',
                value: output.inputs.length,
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
                value: entry.size,
                tags,
            })
            .add({
                metric: 'entries.modules.count',
                type: 'count',
                value: entry.inputs.length,
                tags,
            })
            .add({
                metric: 'entries.assets.count',
                type: 'count',
                value: entry.outputs.length,
                tags,
            });
    }

    return metrics;
};

export const addMetrics = (
    globalContext: GlobalContext,
    optionsDD: OptionsDD,
    metricsToSend: Set<MetricToSend>,
    report?: Report,
): void => {
    const metrics: Set<Metric> = new Set();

    if (report) {
        const { timings } = report;

        if (timings) {
            if (timings.tapables) {
                addPluginMetrics(timings.tapables, metrics);
            }
            if (timings.loaders) {
                addLoaderMetrics(timings.loaders, metrics);
            }
        }
    }

    addUniversalMetrics(globalContext, metrics);

    // Format metrics to be DD ready and apply filters
    for (const metric of metrics) {
        if (optionsDD.filters?.length) {
            let filteredMetric: Metric | null = metric;
            for (const filter of optionsDD.filters) {
                // If it's already been filtered out, no need to keep going.
                if (!filteredMetric) {
                    break;
                }
                filteredMetric = filter(metric);
            }
            if (filteredMetric) {
                metricsToSend.add(getMetric(filteredMetric, optionsDD));
            }
        } else {
            metricsToSend.add(getMetric(metric, optionsDD));
        }
    }

    // Add the number of metrics sent.
    metricsToSend.add(
        getMetric(
            {
                metric: 'metrics.count',
                type: 'count',
                value: metricsToSend.size + 1,
                tags: [],
            },
            optionsDD,
        ),
    );
};
