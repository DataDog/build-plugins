// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import type { GlobalContext, PluginOptions } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import path from 'path';
import type { build } from 'vite';

import {
    getAuthenticatedRequest,
    MissingAuthenticationError,
    type DoAuthenticatedRequest,
} from '../auth';
import { extractExportedFunctions } from '../backend/ast-parsing/extract-backend-functions';
import { encodeQueryName } from '../backend/encodeQueryName';
import { generateProxyModule } from '../backend/proxy-codegen';
import type { BackendFunction } from '../backend/types';
import {
    BACKEND_FILE_RE,
    BACKEND_FILE_WITH_QUERY_RE,
    LOCAL_EXECUTION_LOAD_SUFFIX,
    PLUGIN_NAME,
} from '../constants';
import type { AppsOptionsWithDefaults } from '../types';

import { buildBackendFunctions } from './build-backend-functions';
import { createDevServerMiddleware } from './dev-server';
import { handleUpload } from './handle-upload';

export type ViteBundler = {
    build: typeof build;
};

export interface VitePluginOptions {
    bundler: ViteBundler;
    context: GlobalContext;
    options: AppsOptionsWithDefaults;
}

/**
 * Build BackendFunction entries from discovered export names and generate
 * the frontend proxy module that replaces the original backend code.
 */
function buildProxyModule(
    exportNames: string[],
    id: string,
    buildRoot: string,
): { functions: BackendFunction[]; proxyCode: string } {
    const relativePath = path.relative(buildRoot, id);
    const refPath = relativePath.replace(BACKEND_FILE_RE, '');

    const functions: BackendFunction[] = [];
    const proxyExports: Array<{ exportName: string; queryName: string }> = [];

    for (const exportName of exportNames) {
        const func = {
            relativePath: refPath,
            name: exportName,
            absolutePath: id,
            allowedConnectionIds: [],
        };
        functions.push(func);
        proxyExports.push({ exportName, queryName: encodeQueryName(func) });
    }

    return { functions, proxyCode: generateProxyModule(proxyExports) };
}

/**
 * Create a registry for tracking discovered backend functions.
 * Uses a Map keyed by entryPath so that re-transforms (e.g. during HMR)
 * replace stale entries for a file instead of appending duplicates.
 */
function createBackendFunctionRegistry() {
    const functionsByEntryPath = new Map<string, BackendFunction[]>();

    return {
        /** Replace all entries for a given file. Handles HMR re-transforms. */
        setBackendFunctions(entryPath: string, functions: BackendFunction[]) {
            functionsByEntryPath.set(entryPath, functions);
        },
        /** Get a flat array of all currently registered backend functions. */
        getBackendFunctions(): BackendFunction[] {
            return Array.from(functionsByEntryPath.values()).flat();
        },
    };
}

const APPS_RUNTIME_PATH = path.join(__dirname, './apps-runtime.mjs');

const doDryRunAuthenticatedRequest: DoAuthenticatedRequest = async () => {
    throw new Error('Dry run should not perform authenticated requests.');
};

/**
 * Returns the Vite-specific plugin hooks for the apps plugin.
 *
 * Transform: discovers backend exports and connection allowlists, registers
 * backend functions, and replaces each backend module with its frontend proxy.
 *
 * Production (closeBundle): builds backend functions (if any) then uploads
 * all assets sequentially.
 *
 * Dev (configureServer): registers middleware for local backend function
 * testing when auth credentials are available.
 */
export const getVitePlugin = ({
    bundler,
    context,
    options,
}: VitePluginOptions): PluginOptions['vite'] => {
    const log = context.getLogger(PLUGIN_NAME);
    const { auth } = context;

    context.inject({
        type: 'file',
        position: InjectPosition.MIDDLE,
        value: APPS_RUNTIME_PATH,
    });

    const { setBackendFunctions, getBackendFunctions } = createBackendFunctionRegistry();

    return {
        // The dev server's local-execution path loads backend-function
        // dependencies (e.g. @datadog/apps-backend, @datadog/action-catalog)
        // via `server.ssrLoadModule`, which by default externalizes
        // node_modules packages (a plain `require()`, for speed) rather than
        // transforming them. Those two SDKs ship ESM-only, so an externalized
        // `require()` throws "Cannot use import statement outside a module".
        // `ssr.noExternal` forces Vite's SSR transform pipeline to handle
        // them instead, matching how the production bundling path already
        // inlines every dependency by default.
        config() {
            return {
                ssr: {
                    noExternal: ['@datadog/apps-backend', '@datadog/action-catalog'],
                },
            };
        },
        transform: {
            filter: {
                id: {
                    include: [BACKEND_FILE_WITH_QUERY_RE],
                    exclude: [/node_modules/, /[/\\]dist[/\\]/],
                },
            },
            // For each .backend.* file, parse its named exports, register
            // them as backend functions, and replace the module with a
            // frontend proxy that calls executeBackendFunction at runtime.
            handler(code, id, transformOptions) {
                if (id.endsWith(LOCAL_EXECUTION_LOAD_SUFFIX) && transformOptions?.ssr) {
                    // Local execution needs the real function body, not the RPC-proxy stub generated below.
                    // Real local-execution loads always go through ssrLoadModule, which runs in SSR
                    // context, so this only ever fires for that legitimate path.
                    return null;
                }
                // Any other query on a backend file — no query, the local-execution suffix seen
                // outside SSR (a spoofed client-side import like `./secrets.backend.ts?dd-local-exec`),
                // or an unrecognized query (`./secrets.backend.ts?x`) — falls through to the same
                // safe proxy-stub generation below. Strip the query first so it registers under the
                // same relativePath/query-name as the file's real (unsuffixed) import, not a corrupted
                // duplicate entry.
                const queryIndex = id.indexOf('?');
                const normalizedId = queryIndex === -1 ? id : id.slice(0, queryIndex);

                const ast = this.parse(code);
                const exportNames = extractExportedFunctions(ast, normalizedId);
                if (exportNames.length === 0) {
                    log.warn(
                        `Backend file ${normalizedId} has no exported functions. ` +
                            `Did you forget to add a named export?`,
                    );
                    // Clear any previously registered functions for this file
                    // so stale entries don't persist across HMR re-transforms.
                    setBackendFunctions(normalizedId, []);
                    return { code: '', map: null };
                }

                const { functions, proxyCode } = buildProxyModule(
                    exportNames,
                    normalizedId,
                    context.buildRoot,
                );
                setBackendFunctions(normalizedId, functions);
                log.debug(`Generated proxy for ${normalizedId} with ${functions.length} export(s)`);

                return { code: proxyCode, map: null };
            },
        },
        async closeBundle() {
            let backendOutDir: string | undefined;
            let backendOutputs = new Map<string, string>();
            let backendFunctions = getBackendFunctions();
            if (backendFunctions.length > 0) {
                const result = await buildBackendFunctions(
                    bundler.build,
                    backendFunctions,
                    context.buildRoot,
                    log,
                );
                backendOutDir = result.outDir;
                backendOutputs = result.outputs;
                backendFunctions = result.functions;
            }
            try {
                const doAuthenticatedRequest = options.dryRun
                    ? doDryRunAuthenticatedRequest
                    : getAuthenticatedRequest(options.authOverrides.method, auth, log);

                await handleUpload({
                    backendOutputs,
                    backendFunctions,
                    context,
                    doAuthenticatedRequest,
                    options,
                });
            } finally {
                if (backendOutDir) {
                    await rm(backendOutDir);
                }
            }
        },
        configureServer(server) {
            let doAuthenticatedRequest: DoAuthenticatedRequest | undefined;
            try {
                doAuthenticatedRequest = getAuthenticatedRequest(
                    options.authOverrides.method,
                    auth,
                    log,
                );
            } catch (error) {
                if (!(error instanceof MissingAuthenticationError)) {
                    throw error;
                }
            }

            server.middlewares.use(
                createDevServerMiddleware(
                    bundler.build,
                    server.ssrLoadModule.bind(server),
                    getBackendFunctions,
                    auth,
                    doAuthenticatedRequest,
                    context.buildRoot,
                    log,
                ),
            );
        },
    };
};
