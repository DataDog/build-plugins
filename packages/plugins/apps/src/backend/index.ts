// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, PluginOptions } from '@dd/core/types';

import type { BackendFunction } from './discovery';
import { getRollupPlugin } from './rollup';
import { generateVirtualEntryContent } from './virtual-entry';
import { getVitePlugin } from './vite';

export const BACKEND_VIRTUAL_PREFIX = '\0dd-backend:';

/**
 * Returns a plugin that injects backend functions as additional entry points
 * into the host build. The backendOutputs map is populated during the build
 * and read by the upload plugin in asyncTrueEnd.
 */
export function getBackendPlugin(
    functions: BackendFunction[],
    backendOutputs: Map<string, string>,
    log: Logger,
): PluginOptions {
    const functionsByName = new Map(functions.map((f) => [f.name, f]));

    return {
        name: 'datadog-apps-backend-plugin',
        enforce: 'pre',
        resolveId(source) {
            if (source.startsWith(BACKEND_VIRTUAL_PREFIX)) {
                return source;
            }
            return null;
        },
        load(id) {
            if (!id.startsWith(BACKEND_VIRTUAL_PREFIX)) {
                return null;
            }
            const funcName = id.slice(BACKEND_VIRTUAL_PREFIX.length);
            const func = functionsByName.get(funcName);
            if (!func) {
                log.error(`Backend function "${funcName}" not found.`);
                return null;
            }
            return generateVirtualEntryContent(func.name, func.entryPath);
        },
        rollup: getRollupPlugin(functions, backendOutputs, log),
        vite: getVitePlugin(functions, backendOutputs, log),
    };
}
