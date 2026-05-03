// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import type { AuthOptionsWithDefaults, GlobalContext, Logger, PluginOptions } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import path from 'path';
import type { build } from 'vite';

import type { BackendFunction } from '../backend/discovery';

import { buildBackendFunctions } from './build-backend-functions';
import { createDevServerMiddleware } from './dev-server';

export interface VitePluginOptions {
    viteBuild: typeof build;
    buildRoot: string;
    getBackendFunctions: () => BackendFunction[];
    handleUpload: (backendOutputs: Map<string, string>) => Promise<void>;
    log: Logger;
    auth: AuthOptionsWithDefaults;
    inject: GlobalContext['inject'];
    pluginDir: string;
}

/**
 * Returns the Vite-specific plugin hooks for the apps plugin.
 *
 * Config: injects either the dev-server or postMessage runtime depending on
 * whether Vite is running in `serve` (dev) or `build` (production) mode, so
 * each bundle ships only the transport it needs.
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
    handleUpload,
    log,
    auth,
    inject,
    pluginDir,
}: VitePluginOptions): PluginOptions['vite'] => ({
    config(_userConfig, { command }) {
        // Position MIDDLE so the runtime is injected via Vite's
        // `transformIndexHtml` in dev — BEFORE goes through Rollup's
        // `banner()` which only fires at build time.
        const runtime = command === 'serve' ? 'apps-runtime-dev.mjs' : 'apps-runtime-prod.mjs';
        inject({
            type: 'file',
            position: InjectPosition.MIDDLE,
            value: path.join(pluginDir, runtime),
        });
    },
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
            createDevServerMiddleware(viteBuild, getBackendFunctions, auth, buildRoot, log),
        );
    },
});
