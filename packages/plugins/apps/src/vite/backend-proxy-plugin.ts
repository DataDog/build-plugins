// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import path from 'path';

import type { BackendFunction } from '../backend/discovery';
import { encodeQueryName } from '../backend/discovery';

import { generateProxyModule } from './proxy-codegen';

const PROXY_PREFIX = '\0dd-backend-proxy:';

/**
 * Returns resolveId/load hooks that intercept imports of `.backend.ts` files
 * and replace them with generated proxy modules. Each exported function in the
 * original file is replaced with a wrapper that calls `executeBackendFunction`
 * with the pre-computed query name (hashed path + export name).
 *
 * The raw BackendFunctionRef is never present in the generated proxy code —
 * only the opaque query name string appears in frontend bundles.
 */
export function getBackendProxyHooks(
    backendFunctions: BackendFunction[],
    log: Logger,
): {
    resolveId: (source: string, importer?: string) => string | null;
    load: (id: string) => string | null;
} {
    // Group backend functions by their source file path, pre-computing query names
    const proxyDataByEntryPath = new Map<
        string,
        Array<{ exportName: string; queryName: string }>
    >();
    for (const func of backendFunctions) {
        const existing = proxyDataByEntryPath.get(func.entryPath) ?? [];
        existing.push({
            exportName: func.ref.name,
            queryName: encodeQueryName(func.ref),
        });
        proxyDataByEntryPath.set(func.entryPath, existing);
    }

    return {
        resolveId(source: string, importer?: string): string | null {
            if (!importer) {
                return null;
            }

            // Check if the import resolves to a known .backend.ts file
            const resolved = path.resolve(path.dirname(importer), source);

            // Try with common extensions if the import doesn't have one
            const candidates = [
                resolved,
                `${resolved}.ts`,
                `${resolved}.tsx`,
                `${resolved}.js`,
                `${resolved}.jsx`,
            ];

            for (const candidate of candidates) {
                if (proxyDataByEntryPath.has(candidate)) {
                    log.debug(`Proxying import of ${source} → ${candidate}`);
                    return `${PROXY_PREFIX}${candidate}`;
                }
            }

            return null;
        },

        load(id: string): string | null {
            if (!id.startsWith(PROXY_PREFIX)) {
                return null;
            }

            const entryPath = id.slice(PROXY_PREFIX.length);
            const proxyExports = proxyDataByEntryPath.get(entryPath);

            if (!proxyExports) {
                return null;
            }

            const proxyCode = generateProxyModule(proxyExports);
            log.debug(`Generated proxy for ${entryPath} with ${proxyExports.length} export(s)`);
            return proxyCode;
        },
    };
}
