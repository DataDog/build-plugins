// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginOptions } from '@dd/core/types';

import { getVitePlugin } from './vite';
import type { VitePluginOptions } from './vite';

export type BackendPluginOptions = VitePluginOptions;

/**
 * Returns a plugin that builds backend functions via a separate vite.build()
 * and populates backendOutputs for the upload plugin.
 */
export function getBackendPlugin(options: BackendPluginOptions): PluginOptions {
    return {
        name: 'datadog-apps-backend-plugin',
        enforce: 'pre',
        vite: getVitePlugin(options),
    };
}
