// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, PluginOptions } from '@dd/core/types';

import type { BackendFunction } from '../discovery';
import { getRollupPlugin } from '../rollup';

/**
 * Returns the Vite-specific plugin hooks for backend functions.
 * Extends the Rollup plugin with Vite-compatible types.
 */
export const getVitePlugin = (
    functions: BackendFunction[],
    backendOutputs: Map<string, string>,
    log: Logger,
): PluginOptions['vite'] => {
    const rollupPlugin = getRollupPlugin(functions, backendOutputs, log);

    return {
        ...rollupPlugin,
    };
};
