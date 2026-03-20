// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, PluginOptions } from '@dd/core/types';

import type { BackendFunction } from './discovery';
import { getVitePlugin } from './vite';

export interface BackendPluginContext {
    buildRoot: string;
    bundler: any;
}

/**
 * Returns a plugin that builds backend functions via a separate vite.build()
 * and populates backendOutputs for the upload plugin.
 */
export function getBackendPlugin(
    functions: BackendFunction[],
    backendOutputs: Map<string, string>,
    log: Logger,
    pluginContext?: BackendPluginContext,
): PluginOptions {
    return {
        name: 'datadog-apps-backend-plugin',
        enforce: 'pre',
        vite: getVitePlugin(functions, backendOutputs, log, pluginContext),
    };
}
