// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetInternalPlugins, GetPluginsArg, PluginOptions } from '@dd/core/types';

import { getEsbuildPlugin } from './esbuild';
import { getRollupPlugin } from './rollup';
import { getXpackPlugin } from './xpack';

export const PLUGIN_NAME = 'datadog-build-report-plugin';

export const getBuildReportPlugins: GetInternalPlugins = (arg: GetPluginsArg) => {
    const { context } = arg;
    const log = context.getLogger(PLUGIN_NAME);
    return [
        {
            name: PLUGIN_NAME,
            enforce: 'post',
            esbuild: getEsbuildPlugin(context, log),
            rspack: getXpackPlugin(context, PLUGIN_NAME, log),
            webpack: getXpackPlugin(context, PLUGIN_NAME, log),
            // Vite and Rollup have the same API.
            vite: getRollupPlugin(context, log) as PluginOptions['vite'],
            rollup: getRollupPlugin(context, log),
        },
    ];
};
