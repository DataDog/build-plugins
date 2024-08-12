// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
import type { GlobalContext } from '@dd/core/types';
import type { Metafile } from 'esbuild';
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
import * as es from './metrics/esbuild';
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

const getEsbuildMetrics = (stats: Metafile, globalContext: GlobalContext) => {
    const metrics: Metric[] = [];
    const { cwd } = globalContext;
    const indexed = es.getIndexed(stats, globalContext, cwd);
    metrics.push(...es.getModules(stats, indexed, cwd));
    metrics.push(...es.getAssets(stats, indexed, cwd));
    metrics.push(...es.getEntries(stats, indexed, cwd));
    return metrics;
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
            // TODO: Add entry tags.
            tags: [`moduleName:${input.name}`, `moduleType:${input.type}`],
        });
    }

    // Assets
    for (const output of outputs) {
        metrics.push({
            metric: 'assets.size',
            type: 'size',
            value: output.size,
            // TODO: Add entry tags.
            tags: [`assetName:${output.name}`, `assetType:${output.type}`],
        });
    }

    // Entries
    for (const entry of entries) {
        // Aggregate all modules in this entry.
        metrics.push({
            metric: 'entries.size',
            type: 'size',
            value: entry.size,
            tags: [`entryName:${entry.name}`],
        });
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
        metrics.push(...getWebpackMetrics(statsJson, globalContext.cwd));
        writeFileSync(
            'metrics.webpack.json',
            JSON.stringify(getWebpackMetrics(statsJson, globalContext.cwd), null, 2),
        );
    }

    if (bundler?.esbuild) {
        metrics.push(...getEsbuildMetrics(bundler.esbuild, globalContext));
        writeFileSync(
            'metrics.esbuild.json',
            JSON.stringify(getEsbuildMetrics(bundler.esbuild, globalContext), null, 2),
        );
    }

    metrics.push(...getUniversalMetrics(globalContext));
    writeFileSync(
        'metrics.universal.json',
        JSON.stringify(getUniversalMetrics(globalContext), null, 2),
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
