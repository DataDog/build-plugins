// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BuildReport, GetPlugins, PluginOptions, TimingsReport } from '@dd/core/types';

import { addMetrics } from './common/aggregator';
import { defaultFilters } from './common/filters';
import { getOptionsDD, getTimestamp, validateOptions } from './common/helpers';
import { outputTexts } from './common/output/text';
import { sendMetrics } from './common/sender';
import { PLUGIN_NAME, CONFIG_KEY } from './constants';
import { getEsbuildPlugin } from './esbuild-plugin';
import type { Filter, Metric, MetricToSend, MetricsOptions } from './types';
import { getWebpackPlugin } from './webpack-plugin';

export { CONFIG_KEY, PLUGIN_NAME };

export const helpers = {
    filters: defaultFilters,
};

export type types = {
    Filter: Filter;
    Metric: Metric;
    MetricsOptions: MetricsOptions;
};

export const getPlugins: GetPlugins = ({ options, context }) => {
    const log = context.getLogger(PLUGIN_NAME);
    let realBuildEnd: number = 0;

    const validatedOptions = validateOptions(options, context.bundler.name);
    const plugins: PluginOptions[] = [];

    // If the plugin is not enabled, return an empty array.
    if (!validatedOptions.enable) {
        return plugins;
    }

    // Webpack and Esbuild specific plugins.
    // LEGACY
    const legacyPlugin: PluginOptions = {
        name: PLUGIN_NAME,
        enforce: 'pre',
        esbuild: getEsbuildPlugin(context, log),
        webpack: getWebpackPlugin(context),
        rspack: getWebpackPlugin(context),
    };

    const timeBuild = log.time('build', { start: false });
    // Identify if we need the legacy plugin.
    const needLegacyPlugin =
        validatedOptions.enableTracing &&
        ['esbuild', 'webpack', 'rspack'].includes(context.bundler.name);
    let timingsReport: TimingsReport;
    let buildReport: BuildReport;

    const computeMetrics = async () => {
        context.build.end = Date.now();
        context.build.duration = context.build.end - context.build.start!;
        context.build.writeDuration = context.build.end - realBuildEnd;

        const metrics: Set<MetricToSend> = new Set();
        const optionsDD = getOptionsDD(validatedOptions, context.bundler.name);

        const timeMetrics = log.time(`aggregating metrics`);
        addMetrics(buildReport, optionsDD, metrics, timingsReport);
        timeMetrics.end();

        const timeReport = log.time('outputing report');
        outputTexts(context, log, timingsReport);
        timeReport.end();

        const timeSend = log.time('sending metrics to Datadog');
        await sendMetrics(metrics, { apiKey: context.auth.apiKey, site: context.auth.site }, log);
        timeSend.end();
    };

    // Universal plugin.
    const universalPlugin: PluginOptions = {
        name: 'datadog-universal-metrics-plugin',
        enforce: 'post',
        buildStart() {
            timeBuild.resume();
            context.build.start = context.build.start || Date.now();
            // Set the timestamp to the build start if not provided.
            if (!options[CONFIG_KEY]?.timestamp) {
                validatedOptions.timestamp = getTimestamp(context.build.start);
            }
        },
        buildEnd() {
            timeBuild.end();
            realBuildEnd = Date.now();
        },

        async timings(timings) {
            timingsReport = timings;
            // Once we have both reports, we can compute the metrics.
            if (buildReport) {
                await computeMetrics();
            }
        },

        async buildReport(report) {
            buildReport = report;
            // Once we have both reports (or we don't need the legacy plugin),
            // we can compute the metrics.
            if (timingsReport || !needLegacyPlugin) {
                await computeMetrics();
            }
        },
    };

    if (validatedOptions.enableTracing) {
        plugins.push(legacyPlugin);
    }

    plugins.push(universalPlugin);

    return plugins;
};
