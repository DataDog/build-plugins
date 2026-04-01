// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import path from 'path';
import type { Plugin } from 'vite';

import type { BackendFunction } from '../backend/discovery';

import { generateProxyModule } from './proxy-codegen';

const BACKEND_SUFFIX_RE = /\.backend\.(ts|tsx|js|jsx)$/;
const VIRTUAL_PREFIX = '\0dd-backend-proxy:';

/**
 * Extract the backend function name from a file path.
 * e.g. `/abs/path/getGreeting.backend.ts` → `getGreeting`
 */
function extractFunctionName(filePath: string): string {
    const basename = path.basename(filePath);
    return basename.replace(BACKEND_SUFFIX_RE, '');
}

export interface BackendProxyPluginOptions {
    log: Logger;
}

export interface BackendProxyPlugin {
    /** Vite plugin hooks to spread into the plugin object. */
    hooks: Pick<Plugin, 'resolveId' | 'load'>;
    /** Backend functions discovered through frontend imports (name → absolutePath). */
    discoveredFunctions: Map<string, string>;
}

/**
 * Creates Vite `resolveId`/`load` hooks that intercept `*.backend.ts` imports
 * in frontend code and serve a lightweight proxy module instead of the real
 * server-side source.
 *
 * The proxy calls `executeBackendFunction` from `@datadog/apps-function-query`,
 * which routes to the dev-server HTTP endpoint or iframe postMessage at runtime.
 *
 * As a side-effect, every resolved `.backend.ts` import is tracked in
 * `discoveredFunctions` so the production build can bundle them for upload.
 */
export function createBackendProxyPlugin({ log }: BackendProxyPluginOptions): BackendProxyPlugin {
    const discoveredFunctions = new Map<string, string>();

    const hooks: Pick<Plugin, 'resolveId' | 'load'> = {
        async resolveId(source, importer, options) {
            if (!BACKEND_SUFFIX_RE.test(source)) {
                return null;
            }

            // Resolve the real file path so we can verify it exists.
            const resolved = await this.resolve(source, importer, {
                ...options,
                skipSelf: true,
            });

            if (!resolved) {
                return null;
            }

            const absolutePath = resolved.id;
            const functionName = extractFunctionName(absolutePath);

            // Warn on duplicate function names.
            const existing = discoveredFunctions.get(functionName);
            if (existing && existing !== absolutePath) {
                log.warn(
                    `Duplicate backend function name "${functionName}" ` +
                        `found at ${absolutePath} (already discovered at ${existing}). ` +
                        `Skipping the duplicate.`,
                );
                // Still return the virtual ID so the import resolves — it will
                // use the proxy for the first-discovered function.
            } else {
                discoveredFunctions.set(functionName, absolutePath);
            }

            log.debug(`Resolved backend proxy for "${functionName}" (${absolutePath})`);
            return `${VIRTUAL_PREFIX}${absolutePath}`;
        },

        load(id) {
            if (!id.startsWith(VIRTUAL_PREFIX)) {
                return null;
            }

            const absolutePath = id.slice(VIRTUAL_PREFIX.length);
            const functionName = extractFunctionName(absolutePath);
            return generateProxyModule(functionName);
        },
    };

    return { hooks, discoveredFunctions };
}

/**
 * Convert the proxy plugin's discovered functions map into the
 * `BackendFunction[]` format used by the existing build pipeline.
 */
export function toBackendFunctions(discoveredFunctions: Map<string, string>): BackendFunction[] {
    return Array.from(discoveredFunctions, ([name, entryPath]) => ({
        name,
        entryPath,
    }));
}
