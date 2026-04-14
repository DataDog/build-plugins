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
    functions: BackendFunction[];
    backendOutputs: Map<string, string>;
    handleUpload: () => Promise<void>;
    log: Logger;
    auth: AuthOptionsWithDefaults;
    /** Whether .backend.ts files were found during glob discovery */
    hasBackend: boolean;
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
    functions,
    backendOutputs,
    handleUpload,
    log,
    auth,
    hasBackend,
}: VitePluginOptions): PluginOptions['vite'] => ({
    async closeBundle() {
        let backendOutDir: string | undefined;
        if (functions.length > 0) {
            backendOutDir = await buildBackendFunctions(
                viteBuild,
                functions,
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
        if (hasBackend) {
            server.middlewares.use(
                createDevServerMiddleware(viteBuild, functions, auth, buildRoot, log),
            );
        }
    },
});
