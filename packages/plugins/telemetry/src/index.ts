// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Context } from '@dd/core/plugins';
import type { GetPlugins } from '@dd/core/types';

import { defaultFilters } from './common/helpers';
import { PLUGIN_NAME, CONFIG_KEY } from './constants';
import { getEsbuildPlugin } from './esbuild-plugin';
import type { Filter, Metric, OptionsWithTelemetry, TelemetryOptions } from './types';
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

export const validateOptions = (options: OptionsWithTelemetry): TelemetryOptions => {
    const validatedOptions: TelemetryOptions = options[CONFIG_KEY] || { disabled: false };
    return validatedOptions;
};

export const getPlugins: GetPlugins<OptionsWithTelemetry> = (
    options: OptionsWithTelemetry,
    context: Context,
) => {
    return [
        {
            name: PLUGIN_NAME,
            esbuild: getEsbuildPlugin(options, context),
            webpack: getWebpackPlugin(options, context),
        },
    ];
};
