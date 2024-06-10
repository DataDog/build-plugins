import type { Metric } from '../types';

const filterTreeMetrics = (metric: Metric): Metric | null =>
    // Remove tree metrics because way too verbose
    !/modules\.tree\.(count|size)$/.test(metric.metric) ? metric : null;

const filterSourcemapsAndNodeModules = (metric: Metric): Metric | null =>
    metric.tags.some(
        (tag: string) =>
            // Remove sourcemaps.
            /^assetName:.*\.map$/.test(tag) ||
            // Remove third parties.
            /^moduleName:\/node_modules/.test(tag),
    )
        ? null
        : metric;

const filterMetricsOnThreshold = (metric: Metric): Metric | null => {
    const thresholds = {
        size: 100000,
        count: 10,
        duration: 1000,
    };
    // Allow count for smaller results.
    if (/(entries|loaders|warnings|errors)\.count$/.test(metric.metric)) {
        thresholds.count = 0;
    }
    // Dependencies are huges, lets submit a bit less.
    if (/(modules\.(dependencies|dependents)$)/.test(metric.metric)) {
        thresholds.count = 30;
    }
    // Dependency tree calculation can output a lot of metrics.
    if (/modules\.tree\.count$/.test(metric.metric)) {
        thresholds.count = 150;
    }
    if (/modules\.tree\.size$/.test(metric.metric)) {
        thresholds.size = 1500000;
    }
    // We want to track entry size whatever their size.
    if (/entries\.size$/.test(metric.metric)) {
        thresholds.size = 0;
    }
    // We want to track entry module count whatever their number
    if (/entries\.modules\.count$/.test(metric.metric)) {
        thresholds.count = 0;
    }

    return metric.value > thresholds[metric.type] ? metric : null;
};

export const defaultFilters: ((metric: Metric) => Metric | null)[] = [
    filterTreeMetrics,
    filterSourcemapsAndNodeModules,
    filterMetricsOnThreshold,
];
