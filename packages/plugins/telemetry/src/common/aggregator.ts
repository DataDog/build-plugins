// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    Report,
    StatsJson,
    BundlerStats,
    EsbuildStats,
    Metric,
    MetricToSend,
    OptionsDD,
} from '../types';

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

const getEsbuildMetrics = (stats: EsbuildStats, cwd: string) => {
    const metrics: Metric[] = [];
    const indexed = es.getIndexed(stats, cwd);
    metrics.push(...es.getModules(stats, indexed, cwd));
    metrics.push(...es.getAssets(stats, indexed, cwd));
    metrics.push(...es.getEntries(stats, indexed, cwd));
    return metrics;
};

export const getMetrics = (
    optionsDD: OptionsDD,
    report: Report,
    bundler: BundlerStats,
    cwd: string,
): MetricToSend[] => {
    const { timings, dependencies } = report;
    const metrics: Metric[] = [];

    metrics.push(...getGenerals(getGeneralReport(report, bundler)));

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

    if (bundler.webpack) {
        const statsJson = bundler.webpack.toJson({ children: false });
        metrics.push(...getWebpackMetrics(statsJson, cwd));
    }

    if (bundler.esbuild) {
        metrics.push(...getEsbuildMetrics(bundler.esbuild, cwd));
    }

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
