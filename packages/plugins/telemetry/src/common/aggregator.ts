// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext } from '@dd/core/types';
import type { Metric, MetricToSend, OptionsDD, Report } from '@dd/telemetry-plugin/types';

import { getMetric } from './helpers';
import { getPlugins, getLoaders } from './metrics/common';

const getUniversalMetrics = (globalContext: GlobalContext) => {
    const metrics: Metric[] = [];
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
    metrics.push(
        {
            metric: 'assets.count',
            type: 'count',
            value: outputs.length,
            tags: [],
        },
        {
            metric: 'entries.count',
            type: 'count',
            value: entries.length,
            tags: [],
        },
        {
            metric: 'errors.count',
            type: 'count',
            value: nbErrors,
            tags: [],
        },
        {
            metric: 'modules.count',
            type: 'count',
            value: inputs.length,
            tags: [],
        },
        {
            metric: 'warnings.count',
            type: 'count',
            value: nbWarnings,
            tags: [],
        },
    );

    if (duration) {
        metrics.push({
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
        metrics.push(
            {
                metric: 'modules.size',
                type: 'size',
                value: input.size,
                tags,
            },
            {
                metric: 'modules.dependencies',
                type: 'count',
                value: input.dependencies.size,
                tags,
            },
            {
                metric: 'modules.dependents',
                type: 'count',
                value: input.dependents.size,
                tags,
            },
        );
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
        metrics.push(
            {
                metric: 'assets.size',
                type: 'size',
                value: output.size,
                tags,
            },
            {
                metric: 'assets.modules.count',
                type: 'count',
                value: output.inputs.length,
                tags,
            },
        );
    }

    // Entries
    for (const entry of entries) {
        const tags = [`entryName:${entry.name}`];
        metrics.push(
            {
                metric: 'entries.size',
                type: 'size',
                value: entry.size,
                tags,
            },
            {
                metric: 'entries.modules.count',
                type: 'count',
                value: entry.inputs.length,
                tags,
            },
            {
                metric: 'entries.assets.count',
                type: 'count',
                value: entry.outputs.length,
                tags,
            },
        );
    }

    return metrics;
};

export const getMetrics = (
    globalContext: GlobalContext,
    optionsDD: OptionsDD,
    report?: Report,
): MetricToSend[] => {
    const metrics: Metric[] = [];

    if (report) {
        const { timings } = report;

        if (timings) {
            if (timings.tapables) {
                metrics.push(...getPlugins(timings.tapables));
            }
            if (timings.loaders) {
                metrics.push(...getLoaders(timings.loaders));
            }
        }
    }

    metrics.push(...getUniversalMetrics(globalContext));

    // Format metrics to be DD ready and apply filters
    const metricsToSend: MetricToSend[] = metrics
        .map((m) => {
            let metric: Metric | null = m;
            if (optionsDD.filters?.length) {
                for (const filter of optionsDD.filters) {
                    // Could have been filtered out by an early filter.
                    if (metric) {
                        metric = filter(metric);
                    }
                }
            }
            return metric ? getMetric(metric, optionsDD) : null;
        })
        .filter((m) => m !== null) as MetricToSend[];

    return metricsToSend;
};
