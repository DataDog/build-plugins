"use strict";
// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const helpers_1 = require("./helpers");
const wp = __importStar(require("./metrics/webpack"));
const es = __importStar(require("./metrics/esbuild"));
const common_1 = require("./metrics/common");
const getWebpackMetrics = (statsJson, opts) => {
    const metrics = [];
    const indexed = wp.getIndexed(statsJson, opts.context);
    metrics.push(...wp.getModules(statsJson, indexed, opts.context));
    metrics.push(...wp.getChunks(statsJson, indexed));
    metrics.push(...wp.getAssets(statsJson, indexed));
    metrics.push(...wp.getEntries(statsJson, indexed));
    return metrics;
};
const getEsbuildMetrics = (stats, opts) => {
    const metrics = [];
    const indexed = es.getIndexed(stats, opts.context);
    metrics.push(...es.getModules(stats, indexed, opts.context));
    metrics.push(...es.getAssets(stats, indexed, opts.context));
    metrics.push(...es.getEntries(stats, indexed, opts.context));
    return metrics;
};
exports.getMetrics = (opts, report, bundler) => {
    const { timings, dependencies } = report;
    const metrics = [];
    metrics.push(...common_1.getGenerals(common_1.getGeneralReport(report, bundler)));
    if (timings) {
        if (timings.tapables) {
            metrics.push(...common_1.getPlugins(timings.tapables));
        }
        if (timings.loaders) {
            metrics.push(...common_1.getLoaders(timings.loaders));
        }
    }
    if (dependencies) {
        metrics.push(...common_1.getDependencies(Object.values(dependencies)));
    }
    if (bundler.webpack) {
        const statsJson = bundler.webpack.toJson({ children: false });
        metrics.push(...getWebpackMetrics(statsJson, opts));
    }
    if (bundler.esbuild) {
        metrics.push(...getEsbuildMetrics(bundler.esbuild, opts));
    }
    // Format metrics to be DD ready and apply filters
    const metricsToSend = metrics
        .map((m) => {
        let metric = m;
        if (opts.filters.length) {
            for (const filter of opts.filters) {
                // Could have been filtered out by an early filter.
                if (metric) {
                    metric = filter(metric);
                }
            }
        }
        return metric ? helpers_1.getMetric(metric, opts) : null;
    })
        .filter((m) => m !== null);
    return metricsToSend;
};
