// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Entry, File, GlobalContext, Output } from '@dd/core/types';
import { writeFileSync } from 'fs';

import type { Metric, MetricToSend, OptionsDD, Report } from '../types';

import { getMetric } from './helpers';
import { getGenerals, getGeneralReport, getPlugins, getLoaders } from './metrics/common';

const getModuleEntryTags = (file: File, entries: Entry[]) => {
    const entryNames: string[] = entries
        .filter((entry) => {
            const foundModules = entry.inputs.filter((input) => {
                return input.name === file.name;
            });
            return foundModules.length;
        })
        .map((entry) => entry.name);

    return Array.from(new Set(entryNames)).map((entryName) => `entryName:${entryName}`);
};

const getAssetEntryTags = (file: File, entries: Entry[]) => {
    // Include sourcemaps in the tagging.
    const cleanAssetName = file.name.replace(/\.map$/, '');
    const entryNames: string[] = entries
        .filter((entry) => {
            const foundModules = entry.outputs.filter((output) => {
                return output.name === cleanAssetName;
            });
            return foundModules.length;
        })
        .map((entry) => entry.name);

    return Array.from(new Set(entryNames)).map((entryName) => `entryName:${entryName}`);
};

const getModuleAssetTags = (file: File, outputs: Output[]) => {
    const assetNames: string[] = outputs
        .filter((output) => {
            return output.inputs.find((input) => input.filepath === file.filepath);
        })
        .map((output) => output.name);

    return Array.from(new Set(assetNames)).map((assetName) => `assetName:${assetName}`);
};

const getUniversalMetrics = (globalContext: GlobalContext) => {
    const metrics: Metric[] = [];
    const inputs = globalContext.build.inputs || [];
    const outputs = globalContext.build.outputs || [];
    const entries = globalContext.build.entries || [];
    // Modules
    for (const input of inputs) {
        const tags = [
            `moduleName:${input.name}`,
            `moduleType:${input.type}`,
            ...getModuleEntryTags(input, entries),
            ...getModuleAssetTags(input, outputs),
        ];
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
                value: input.dependencies.length,
                tags,
            },
            {
                metric: 'modules.dependents',
                type: 'count',
                value: input.dependents.length,
                tags,
            },
        );
    }

    // Assets
    for (const output of outputs) {
        metrics.push(
            {
                metric: 'assets.size',
                type: 'size',
                value: output.size,
                tags: [
                    `assetName:${output.name}`,
                    `assetType:${output.type}`,
                    ...getAssetEntryTags(output, entries),
                ],
            },
            {
                metric: 'assets.modules.count',
                type: 'count',
                value: output.inputs.length,
                tags: [
                    `assetName:${output.name}`,
                    `assetType:${output.type}`,
                    ...getAssetEntryTags(output, entries),
                ],
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

    metrics.push(...getGenerals(getGeneralReport(globalContext)));

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

    const universalMetrics = getUniversalMetrics(globalContext);
    metrics.push(...universalMetrics);
    writeFileSync(
        `metrics.universal.${globalContext.bundler.fullName}.json`,
        JSON.stringify(universalMetrics, null, 4),
    );

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
