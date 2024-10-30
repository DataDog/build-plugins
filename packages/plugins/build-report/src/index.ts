// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getLogger } from '@dd/core/log';
import type { GlobalContext, Options, PluginOptions } from '@dd/core/types';

import { getEsbuildPlugin } from './esbuild';
import { getRollupPlugin } from './rollup';
import { getWebpackPlugin } from './webpack';

const PLUGIN_NAME = 'datadog-build-report-plugin';

export const getBuildReportPlugin = (opts: Options, context: GlobalContext): PluginOptions => {
    const log = getLogger(opts.logLevel, PLUGIN_NAME);
    return {
        name: PLUGIN_NAME,
        enforce: 'post',
        esbuild: getEsbuildPlugin(context, log),
        webpack: getWebpackPlugin(context, PLUGIN_NAME, log),
        // Vite and Rollup have the same API.
        vite: getRollupPlugin(context, log),
        rollup: getRollupPlugin(context, log),
    };
};
