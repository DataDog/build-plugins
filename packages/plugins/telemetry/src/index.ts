// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getLogger } from '@dd/core/log';
import type { GlobalContext, GetPlugins } from '@dd/core/types';

import { getMetrics } from './common/aggregator';
import { defaultFilters } from './common/filters';
import { getOptionsDD, validateOptions } from './common/helpers';
import { outputFiles } from './common/output/files';
import { outputTexts } from './common/output/text';
import { sendMetrics } from './common/sender';
import { PLUGIN_NAME, CONFIG_KEY } from './constants';
import { getEsbuildPlugin } from './esbuild-plugin';
import type {
    BundlerContext,
    Filter,
    Metric,
    OptionsWithTelemetry,
    TelemetryOptions,
} from './types';
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

export const getPlugins: GetPlugins<OptionsWithTelemetry> = (
    options: OptionsWithTelemetry,
    context: GlobalContext,
) => {
    let realBuildEnd: number = 0;
    const bundlerContext: BundlerContext = {
        start: Date.now(),
    };

    const telemetryOptions = validateOptions(options);
    const logger = getLogger(options.logLevel, PLUGIN_NAME);

    return [
        // Webpack and Esbuild specific plugins.
        // LEGACY
        {
            name: PLUGIN_NAME,
            enforce: 'pre',
            esbuild: getEsbuildPlugin(bundlerContext, context, logger),
            webpack: getWebpackPlugin(bundlerContext, context),
        },
        // Universal plugin.
        {
            name: 'datadog-universal-telemetry-plugin',
            enforce: 'post',
            buildStart() {
                context.build.start = context.build.start || Date.now();
            },
            buildEnd() {
                realBuildEnd = Date.now();
            },

            // Move as much as possible in the universal plugin.
            async writeBundle() {
                context.build.end = Date.now();
                context.build.duration = context.build.end - context.build.start!;
                context.build.writeDuration = context.build.end - realBuildEnd;

                const metrics = [];
                const optionsDD = getOptionsDD(telemetryOptions);

                metrics.push(...getMetrics(context, optionsDD, bundlerContext.report));

                // TODO Extract the files output in an internal plugin.
                // with validateOptions and create a TelemetryOptionsWithDefaults.
                await outputFiles(
                    bundlerContext,
                    telemetryOptions.output || true,
                    logger,
                    context.cwd,
                );
                outputTexts(context, logger, bundlerContext.report, telemetryOptions.output);

                await sendMetrics(
                    metrics,
                    { apiKey: context.auth?.apiKey, endPoint: telemetryOptions.endPoint },
                    logger,
                );
            },
        },
    ];
};

// Metrics
/*
    modules.size
    modules.count
    assets.size
    assets.count
    entries.size
    entries.count
    plugins.count
*/
