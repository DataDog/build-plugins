// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createHash } from 'crypto';
import path from 'path';

import { isBackendFunctionFile } from '../backend/backend-sources';

// The `\0` prefix is the bundler convention for "not a real file": Rollup and Rolldown both leave
// such modules out of sourcemaps, and Vite's own resolvers and loaders don't touch them.
const FRONTEND_PROXY_ID_PREFIX = '\0dd-apps-backend-proxy:';

export const FRONTEND_PROXY_ID_RE = new RegExp(`^${FRONTEND_PROXY_ID_PREFIX}`);

/** Where proxy ids are computed from: known once Vite's config is resolved, after plugin creation. */
export interface FrontendProxyPaths {
    buildRoot: string;
    outDir: string;
}

/** The subset of a bundler's resolved id this module reads and rewrites. */
interface ResolvedModule {
    id: string;
    external?: boolean | 'absolute' | 'relative';
}

/**
 * Gives each backend module reached by a frontend build an opaque module id of its own.
 *
 * The frontend only ever gets a proxy stub for a backend module. When that stub is the backend
 * module's own transformed code, the module keeps the backend file's identity: its path, and the
 * sourcemaps earlier transforms (like TypeScript's) attached to it, which carry the original
 * source as `sourcesContent`. The bundler then ships them in the frontend's sourcemaps (Rolldown
 * keeps the first map's sources whatever later transforms return, so no transform result can
 * remove them). Under its own id, the stub is a module whose only content is the stub itself.
 *
 * Ids are derived from the path relative to the build root, so they're stable across machines,
 * and hashed, so the backend file's name doesn't reach chunk names or bundle comments either.
 */
export function createFrontendProxyModules(getPaths: () => FrontendProxyPaths) {
    const sourceIdByProxyId = new Map<string, string>();

    /** The proxy module id standing in for the resolved backend module `sourceId`. */
    const getProxyId = (sourceId: string): string => {
        // Only the file path is made relative: normalizing the query or fragment along with it
        // could turn two different ids into the same one (`a.backend.ts?x=/../b.backend.ts`).
        const suffixIndex = sourceId.search(/[?#]/);
        const filePath = suffixIndex === -1 ? sourceId : sourceId.slice(0, suffixIndex);
        const suffix = suffixIndex === -1 ? '' : sourceId.slice(suffixIndex);
        const relativePath = path
            .relative(getPaths().buildRoot, filePath)
            .split(path.sep)
            .join('/');
        const hash = createHash('sha256').update(`${relativePath}${suffix}`).digest('hex');
        const proxyId = `${FRONTEND_PROXY_ID_PREFIX}${hash}`;
        sourceIdByProxyId.set(proxyId, sourceId);
        return proxyId;
    };

    return {
        getProxyId,
        /**
         * In a frontend build, swaps a resolved backend module for its proxy module id, so the
         * frontend graph only ever holds the proxy stub (see `load` in index.ts). Anything else,
         * including an unresolved or external import, passes through unchanged.
         */
        resolveFrontendProxy<T extends ResolvedModule>(resolved: T | null): T | null {
            if (!resolved || resolved.external) {
                return resolved;
            }
            const { buildRoot, outDir } = getPaths();
            if (!isBackendFunctionFile(resolved.id, buildRoot, outDir)) {
                return resolved;
            }
            return { ...resolved, id: getProxyId(resolved.id) };
        },
        /** The backend module a proxy module id stands in for, if it is one. */
        getSourceId(proxyId: string): string | undefined {
            return sourceIdByProxyId.get(proxyId);
        },
    };
}
