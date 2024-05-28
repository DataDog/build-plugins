// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPlugins } from '@dd/core/types';

import { defaultFilters } from './common/helpers';
import { PLUGIN_NAME } from './constants';
import { getEsbuildPlugin } from './esbuild-plugin';
import type { OptionsWithTelemetryEnabled } from './types';
import { getWebpackPlugin } from './webpack-plugin';

export { CONFIG_KEY, PLUGIN_NAME } from './constants';

export const helpers = {
    filters: defaultFilters,
};

export const getPlugins: GetPlugins<OptionsWithTelemetryEnabled> = (
    opt: OptionsWithTelemetryEnabled,
) => {
    return [
        {
            name: PLUGIN_NAME,
            enforce: 'pre',
            esbuild: getEsbuildPlugin(opt),
            webpack: getWebpackPlugin(opt),
        },
    ];
};
