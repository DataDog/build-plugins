// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, PluginOptions } from '@dd/core/types';
import type { build } from 'vite';

import type { BackendFunction } from './discovery';
import { getVitePlugin } from './vite';

/**
 * Returns a plugin that builds backend functions via a separate vite.build()
 * and populates backendOutputs for the upload plugin.
 */
export function getBackendPlugin(
    viteBuild: typeof build,
    buildRoot: string,
    functions: BackendFunction[],
    backendOutputs: Map<string, string>,
    log: Logger,
): PluginOptions {
    return {
        name: 'datadog-apps-backend-plugin',
        enforce: 'pre',
        vite: getVitePlugin(viteBuild, buildRoot, functions, backendOutputs, log),
    };
}
