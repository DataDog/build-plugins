// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPlugins, Metric, PluginOptions } from '@dd/core/types';

import { getUniversalMetrics, getPluginMetrics, getLoaderMetrics } from './common/aggregator';
import { defaultFilters } from './common/filters';
import { getMetricsToSend, getTimestamp, validateOptions } from './common/helpers';
import { outputTexts } from './common/output/text';
import { sendMetrics } from './common/sender';
import { PLUGIN_NAME, CONFIG_KEY } from './constants';
import { getEsbuildPlugin } from './esbuild-plugin';
import type { Filter, MetricsOptions, TimingsReport } from './types';
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
    // Will be modified by the legacy plugins.
    const timings: TimingsReport = {};

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
        esbuild: getEsbuildPlugin(timings, context, log),
        webpack: getWebpackPlugin(timings, context),
        rspack: getWebpackPlugin(timings, context),
    };

    const timeBuild = log.time('build', { start: false });
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

        // Move as much as possible in the universal plugin.
        async writeBundle() {
            context.build.end = Date.now();
            context.build.duration = context.build.end - context.build.start!;
            context.build.writeDuration = context.build.end - realBuildEnd;

            const timeMetrics = log.time(`aggregating metrics`);
            const timestamp = validatedOptions.timestamp;

            const universalMetrics = getUniversalMetrics(context.build, timestamp);
            const pluginMetrics = getPluginMetrics(timings.tapables, timestamp);
            const loaderMetrics = getLoaderMetrics(timings.loaders, timestamp);

            const allMetrics = new Set([...universalMetrics, ...pluginMetrics, ...loaderMetrics]);

            const metricsToSend = getMetricsToSend(
                allMetrics,
                timestamp,
                validatedOptions.filters,
                validatedOptions.tags,
                validatedOptions.prefix,
            );

            timeMetrics.end();

            const timeReport = log.time('outputing report');
            outputTexts(context, log, timings);
            timeReport.end();

            const timeSend = log.time('sending metrics to Datadog');
            await sendMetrics(
                metricsToSend,
                { apiKey: context.auth.apiKey, site: context.auth.site },
                log,
            );
            timeSend.end();
        },
    };

    if (validatedOptions.enableTracing) {
        plugins.push(legacyPlugin);
    }

    plugins.push(universalPlugin);

    return plugins;
};
