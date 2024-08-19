// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Entry, File, GlobalContext } from '@dd/core/types';
import { writeFileSync } from 'fs';

import type { StatsJson, Metric, MetricToSend, OptionsDD, BundlerContext } from '../types';

import { getMetric } from './helpers';
import {
    getGenerals,
    getGeneralReport,
    getPlugins,
    getLoaders,
    getDependencies,
} from './metrics/common';
import * as wp from './metrics/webpack';

const getWebpackMetrics = (statsJson: StatsJson, cwd: string) => {
    const metrics: Metric[] = [];
    const indexed = wp.getIndexed(statsJson, cwd);
    metrics.push(...wp.getModules(statsJson, indexed, cwd));
    metrics.push(...wp.getChunks(statsJson, indexed));
    metrics.push(...wp.getAssets(statsJson, indexed));
    metrics.push(...wp.getEntries(statsJson, indexed));
    return metrics;
};

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

const getUniversalMetrics = (globalContext: GlobalContext) => {
    const metrics: Metric[] = [];
    const inputs = globalContext.build.inputs || [];
    const outputs = globalContext.build.outputs || [];
    const entries = globalContext.build.entries || [];

    // Modules
    for (const input of inputs) {
        metrics.push({
            metric: 'modules.size',
            type: 'size',
            value: input.size,
            tags: [
                `moduleName:${input.name}`,
                `moduleType:${input.type}`,
                ...getModuleEntryTags(input, entries),
            ],
        });
    }

    // Assets
    for (const output of outputs) {
        metrics.push({
            metric: 'assets.size',
            type: 'size',
            value: output.size,
            tags: [
                `assetName:${output.name}`,
                `assetType:${output.type}`,
                ...getAssetEntryTags(output, entries),
            ],
        });
    }

    // Entries
    for (const entry of entries) {
        // Aggregate all modules in this entry.
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
    bundlerContext: BundlerContext,
    globalContext: GlobalContext,
    optionsDD: OptionsDD,
): MetricToSend[] => {
    const { report, bundler } = bundlerContext;

    const metrics: Metric[] = [];

    metrics.push(...getGenerals(getGeneralReport(globalContext)));

    if (report) {
        const { timings, dependencies } = report;

        if (timings) {
            if (timings.tapables) {
                metrics.push(...getPlugins(timings.tapables));
            }
            if (timings.loaders) {
                metrics.push(...getLoaders(timings.loaders));
            }
        }

        if (dependencies) {
            metrics.push(...getDependencies(Object.values(dependencies)));
        }
    }

    if (bundler?.webpack) {
        const statsJson = bundler.webpack.toJson({ children: false });
        const webpackMetrics = getWebpackMetrics(statsJson, globalContext.cwd);
        metrics.push(...webpackMetrics);
        writeFileSync(
            `metrics.${globalContext.bundler.fullName}.json`,
            JSON.stringify(webpackMetrics, null, 4),
        );
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
