// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, Logger, PluginOptions } from '@dd/core/types';

import { PLUGIN_NAME } from './constants';
import { getDebugIdEsbuildPlugin } from './esbuild';
import { getDebugIdRollupPlugin } from './rollup';
import { getDebugIdXpackPlugin } from './xpack';

export const getDebugIdPlugin = (
    bundler: any,
    log: Logger,
    context: GlobalContext,
    debugIds: Map<string, string>,
): PluginOptions => {
    // rollup and vite both consume rollup's generateBundle hook.
    const rollupPlugin = getDebugIdRollupPlugin(context, debugIds);
    return {
        name: PLUGIN_NAME,
        enforce: 'post',
        esbuild: getDebugIdEsbuildPlugin(log, context, debugIds),
        rollup: rollupPlugin,
        vite: rollupPlugin,
        webpack: getDebugIdXpackPlugin(bundler, log, context, debugIds),
        rspack: getDebugIdXpackPlugin(bundler, log, context, debugIds),
    };
};
