// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BuildReport, GetPlugins, PluginOptions, Report } from '@dd/core/types';

import { addMetrics } from './common/aggregator';
import { defaultFilters } from './common/filters';
import { getOptionsDD, validateOptions } from './common/helpers';
import { outputFiles } from './common/output/files';
import { outputTexts } from './common/output/text';
import { sendMetrics } from './common/sender';
import { PLUGIN_NAME, CONFIG_KEY } from './constants';
import { getEsbuildPlugin } from './esbuild-plugin';
import type { BundlerContext, Filter, Metric, MetricToSend, TelemetryOptions } from './types';
import { getWebpackPlugin } from './webpack-plugin';

export { CONFIG_KEY, PLUGIN_NAME };

export const helpers = {
    filters: defaultFilters,
};

export type types = {
    Filter: Filter;
    Metric: Metric;
    TelemetryOptions: TelemetryOptions;
};

export const getPlugins: GetPlugins = ({ options, context }) => {
    const log = context.getLogger(PLUGIN_NAME);
    let realBuildEnd: number = 0;
    const bundlerContext: BundlerContext = {
        start: Date.now(),
    };

    const validatedOptions = validateOptions(options);
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
        esbuild: getEsbuildPlugin(bundlerContext, context, log),
        webpack: getWebpackPlugin(bundlerContext, context),
        rspack: getWebpackPlugin(bundlerContext, context),
    };
    const timeBuild = log.time('build', { start: false });
    // Identify if we need the legacy plugin.
    const needLegacyPlugin =
        validatedOptions.enableTracing &&
        ['esbuild', 'webpack4', 'webpack5', 'rspack'].includes(context.bundler.fullName);
    let bundlerContextReport: Report;
    let buildReport: BuildReport;

    const computeMetrics = async () => {
        context.build.end = Date.now();
        context.build.duration = context.build.end - context.build.start!;
        context.build.writeDuration = context.build.end - realBuildEnd;

        const metrics: Set<MetricToSend> = new Set();
        const optionsDD = getOptionsDD(validatedOptions);

        const timeMetrics = log.time(`aggregating metrics`);
        addMetrics(buildReport, optionsDD, metrics, bundlerContext.report);
        timeMetrics.end();

        // TODO Extract the files output in an internal plugin.
        const timeWrite = log.time(`writing to files`);
        await outputFiles(
            { report: bundlerContext.report, metrics },
            validatedOptions.output,
            log,
            context.bundler.outDir,
        );
        timeWrite.end();
        const timeReport = log.time('outputing report');
        outputTexts(context, log, bundlerContext.report);
        timeReport.end();

        const timeSend = log.time('sending metrics to Datadog');
        await sendMetrics(
            metrics,
            { apiKey: context.auth?.apiKey, endPoint: validatedOptions.endPoint },
            log,
        );
        timeSend.end();
    };

    // Universal plugin.
    const universalPlugin: PluginOptions = {
        name: 'datadog-universal-telemetry-plugin',
        enforce: 'post',
        buildStart() {
            timeBuild.resume();
            context.build.start = context.build.start || Date.now();
        },
        buildEnd() {
            timeBuild.end();
            realBuildEnd = Date.now();
        },

        async telemetryBundlerContext(report) {
            bundlerContextReport = report;
            // Once we have both reports, we can compute the metrics.
            if (buildReport) {
                await computeMetrics();
            }
        },

        async buildReport(report) {
            buildReport = report;
            // Once we have both reports (or we don't need the legacy plugin),
            // we can compute the metrics.
            if (bundlerContextReport || !needLegacyPlugin) {
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
