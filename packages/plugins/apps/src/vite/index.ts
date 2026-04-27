// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import type { AuthOptionsWithDefaults, Logger, PluginOptions } from '@dd/core/types';
import type { build } from 'vite';

import type { BackendFunction } from '../backend/discovery';

import { buildBackendFunctions } from './build-backend-functions';
import { createDevServerMiddleware } from './dev-server';

export interface VitePluginOptions {
    viteBuild: typeof build;
    buildRoot: string;
    getBackendFunctions: () => BackendFunction[];
    getConnectionIds: () => string[];
    handleUpload: (backendOutputs: Map<string, string>) => Promise<void>;
    log: Logger;
    auth: AuthOptionsWithDefaults;
}

/**
 * Returns the Vite-specific plugin hooks for the apps plugin.
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
    getBackendFunctions,
    getConnectionIds,
    handleUpload,
    log,
    auth,
}: VitePluginOptions): PluginOptions['vite'] => ({
    async closeBundle() {
        let backendOutDir: string | undefined;
        let backendOutputs = new Map<string, string>();
        const functions = getBackendFunctions();
        if (functions.length > 0) {
            const result = await buildBackendFunctions(viteBuild, functions, buildRoot, log);
            backendOutDir = result.outDir;
            backendOutputs = result.outputs;
        }
        try {
            await handleUpload(backendOutputs);
        } finally {
            if (backendOutDir) {
                await rm(backendOutDir);
            }
        }
    },
    configureServer(server) {
        server.middlewares.use(
            createDevServerMiddleware({
                viteBuild,
                getBackendFunctions,
                getConnectionIds,
                auth,
                projectRoot: buildRoot,
                log,
            }),
        );
    },
});
