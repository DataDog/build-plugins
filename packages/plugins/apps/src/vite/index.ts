// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import type { AuthOptionsWithDefaults, Logger, PluginOptions } from '@dd/core/types';
import type { build } from 'vite';

import type { BackendFunction } from '../backend/discovery';

import { createBackendProxyPlugin, toBackendFunctions } from './backend-proxy-plugin';
import { buildBackendFunctions } from './build-backend-functions';
import { createDevServerMiddleware } from './dev-server';

export interface VitePluginOptions {
    viteBuild: typeof build;
    buildRoot: string;
    functions: BackendFunction[];
    backendOutputs: Map<string, string>;
    handleUpload: () => Promise<void>;
    log: Logger;
    auth: AuthOptionsWithDefaults;
}

/**
 * Returns the Vite-specific plugin hooks for the apps plugin.
 *
 * Resolution (resolveId/load): intercepts `*.backend.ts` imports in frontend
 * code and serves a proxy module that delegates to `executeBackendFunction`.
 *
 * Production (closeBundle): builds backend functions (if any) then uploads
 * all assets sequentially.
 *
 * Dev (configureServer): registers middleware for local backend function
 * testing when auth credentials are available.
 */
export const getVitePlugin = ({
    viteBuild,
    buildRoot,
    functions,
    backendOutputs,
    handleUpload,
    log,
    auth,
}: VitePluginOptions): PluginOptions['vite'] => {
    const proxyPlugin = createBackendProxyPlugin({ log });

    return {
        resolveId: proxyPlugin.hooks.resolveId,
        load: proxyPlugin.hooks.load,
        async closeBundle() {
            // Merge directory-discovered functions with import-discovered ones.
            const importDiscovered = toBackendFunctions(proxyPlugin.discoveredFunctions);
            const existingNames = new Set(functions.map((f) => f.name));
            const allFunctions = [
                ...functions,
                ...importDiscovered.filter((f) => !existingNames.has(f.name)),
            ];

            let backendOutDir: string | undefined;
            if (allFunctions.length > 0) {
                backendOutDir = await buildBackendFunctions(
                    viteBuild,
                    allFunctions,
                    backendOutputs,
                    buildRoot,
                    log,
                );
            }
            try {
                await handleUpload();
            } finally {
                if (backendOutDir) {
                    await rm(backendOutDir);
                }
            }
        },
        configureServer(server) {
            // Merge directory-discovered functions with any already discovered
            // by the proxy plugin during dev server startup.
            const allFunctions = () => {
                const importDiscovered = toBackendFunctions(proxyPlugin.discoveredFunctions);
                const existingNames = new Set(functions.map((f) => f.name));
                return [
                    ...functions,
                    ...importDiscovered.filter((f) => !existingNames.has(f.name)),
                ];
            };

            server.middlewares.use(
                createDevServerMiddleware(viteBuild, allFunctions, auth, buildRoot, log),
            );
        },
    };
};
