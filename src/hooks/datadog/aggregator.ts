// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Report, StatsJson, BundlerStats, EsbuildStats } from '../../types';
import { getMetric } from './helpers';
import { Metric, MetricToSend, GetMetricsOptions } from './types';
import * as wp from './metrics/webpack';
import * as es from './metrics/esbuild';
import {
    getGenerals,
    getGeneralReport,
    getPlugins,
    getLoaders,
    getDependencies,
} from './metrics/common';

const getWebpackMetrics = (statsJson: StatsJson, opts: GetMetricsOptions) => {
    const metrics: Metric[] = [];
    const indexed = wp.getIndexed(statsJson, opts.context);
    metrics.push(...wp.getModules(statsJson, indexed, opts.context));
    metrics.push(...wp.getChunks(statsJson, indexed));
    metrics.push(...wp.getAssets(statsJson, indexed));
    metrics.push(...wp.getEntries(statsJson, indexed));
    return metrics;
};

const getEsbuildMetrics = (stats: EsbuildStats, opts: GetMetricsOptions) => {
    const metrics: Metric[] = [];
    const indexed = es.getIndexed(stats, opts.context);
    metrics.push(...es.getModules(stats, indexed, opts.context));
    metrics.push(...es.getAssets(stats, indexed, opts.context));
    metrics.push(...es.getEntries(stats, indexed, opts.context));
    return metrics;
};

export const getMetrics = (
    opts: GetMetricsOptions,
    report: Report,
    bundler: BundlerStats
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
        metrics.push(...getWebpackMetrics(statsJson, opts));
    }

    if (bundler.esbuild) {
        metrics.push(...getEsbuildMetrics(bundler.esbuild, opts));
    }

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
