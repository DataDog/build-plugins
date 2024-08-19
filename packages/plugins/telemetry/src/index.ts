// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getLogger } from '@dd/core/log';
import type { GlobalContext, GetPlugins } from '@dd/core/types';

import { defaultFilters } from './common/filters';
import { validateOptions } from './common/helpers';
import { output } from './common/output';
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
            esbuild: getEsbuildPlugin(bundlerContext, context, telemetryOptions, logger),
            webpack: getWebpackPlugin(bundlerContext, context, telemetryOptions, logger),
        },
        // Universal plugin.
        {
            name: 'datadog-universal-telemetry-plugin',
            enforce: 'pre',
            buildStart() {
                context.build.start = context.build.start || Date.now();
            },
            buildEnd() {
                realBuildEnd = Date.now();
            },

            // Move as much as possible in the universal plugin.
            // As well as the output and the sender.
            async writeBundle() {
                context.build.end = Date.now();
                context.build.duration = context.build.end - context.build.start!;
                context.build.writeDuration = context.build.end - realBuildEnd;

                console.log('END TELEMETRY', context.bundler.fullName);

                await output(bundlerContext, context, telemetryOptions, logger);
                await sendMetrics(
                    bundlerContext.metrics,
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
