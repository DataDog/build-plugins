// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import type { GlobalContext, PluginOptions } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import path from 'path';
import type { build } from 'vite';

import { extractExportedFunctions } from '../backend/ast-parsing/extract-backend-functions';
import { encodeQueryName } from '../backend/encodeQueryName';
import { generateProxyModule } from '../backend/proxy-codegen';
import type { BackendFunction } from '../backend/types';
import { BACKEND_FILE_RE, PLUGIN_NAME } from '../constants';
import type { AppsOptionsWithDefaults } from '../types';

import { buildBackendFunctions } from './build-backend-functions';
import { createDevServerMiddleware } from './dev-server';
import { handleUpload } from './handle-upload';

export type ViteBundler = {
    build: typeof build;
    transformWithEsbuild: (typeof import('vite'))['transformWithEsbuild'];
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

/**
 * Returns the Vite-specific plugin hooks for the apps plugin.
 *
 * Transform: discovers backend exports, registers backend functions, and
 * replaces each backend module with its frontend proxy.
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
    const { auth, buildRoot } = context;

    context.inject({
        type: 'file',
        position: InjectPosition.MIDDLE,
        value: APPS_RUNTIME_PATH,
    });

    const { setBackendFunctions, getBackendFunctions } = createBackendFunctionRegistry();

    return {
        transform: {
            filter: {
                id: {
                    include: [BACKEND_FILE_RE],
                    exclude: [/node_modules/, /[/\\]dist[/\\]/],
                },
            },
            // For each .backend.* file, parse its named exports, register
            // them as backend functions, and replace the module with a
            // frontend proxy that calls executeBackendFunction at runtime.
            async handler(code, id) {
                const ast = this.parse(code);
                const exportNames = extractExportedFunctions(ast, id);
                if (exportNames.length === 0) {
                    log.warn(
                        `Backend file ${id} has no exported functions. ` +
                            `Did you forget to add a named export?`,
                    );
                    // Clear any previously registered functions for this file
                    // so stale entries don't persist across HMR re-transforms.
                    setBackendFunctions(id, []);
                    return { code: '', map: null };
                }

                const { functions, proxyCode } = buildProxyModule(exportNames, id, buildRoot);
                setBackendFunctions(id, functions);
                log.debug(`Generated proxy for ${id} with ${functions.length} export(s)`);

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
                    buildRoot,
                    log,
                );
                backendOutDir = result.outDir;
                backendOutputs = result.outputs;
                backendFunctions = result.functions;
            }
            try {
                await handleUpload({
                    backendOutputs,
                    backendFunctions,
                    context,
                    options,
                });
            } finally {
                if (backendOutDir) {
                    await rm(backendOutDir);
                }
            }
        },
        configureServer(server) {
            server.middlewares.use(
                createDevServerMiddleware(bundler.build, getBackendFunctions, auth, buildRoot, log),
            );
        },
    };
};
