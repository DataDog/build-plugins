// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import type { AuthOptionsWithDefaults, Logger, PluginOptions } from '@dd/core/types';
import path from 'path';
import type { build } from 'vite';

import type { BackendFunction } from '../backend/discovery';
import { findConnectionsFile } from '../backend/extract-connections';
import type { ConnectionIdsRegistry } from '../index';

import { buildBackendFunctions } from './build-backend-functions';
import { createDevServerMiddleware } from './dev-server';

export interface VitePluginOptions {
    viteBuild: typeof build;
    buildRoot: string;
    getBackendFunctions: () => BackendFunction[];
    connectionRegistry: ConnectionIdsRegistry;
    handleUpload: (backendOutputs: Map<string, string>) => Promise<void>;
    log: Logger;
    auth: AuthOptionsWithDefaults;
}

export const getVitePlugin = ({
    viteBuild,
    buildRoot,
    getBackendFunctions,
    connectionRegistry,
    handleUpload,
    log,
    auth,
}: VitePluginOptions): PluginOptions['vite'] => ({
    // Fires once per production build and once at dev-server start. In
    // `vite build --watch` it also re-fires when connections.ts changes
    // because addWatchFile registers it as a build dependency. In the dev
    // server, addWatchFile only registers chokidar tracking — buildStart
    // does NOT re-run on edits there; handleHotUpdate refreshes the
    // registry mid-session instead (the per-request nested viteBuild uses
    // a different config without the apps plugin, so its buildStart can't
    // help).
    async buildStart() {
        connectionRegistry.setParse((code) => this.parse(code));
        const { filePath } = await connectionRegistry.loadAndSetConnectionIds(async (id) => {
            const info = await this.load({ id });
            return info.code ?? null;
        });
        if (filePath) {
            this.addWatchFile(filePath);
        }
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
            createDevServerMiddleware({
                viteBuild,
                getBackendFunctions,
                getConnectionIds: connectionRegistry.getConnectionIds,
                auth,
                projectRoot: buildRoot,
                log,
            }),
        );
    },
    async handleHotUpdate({ file, server }) {
        if (!CONNECTIONS_BASENAME_RE.test(path.basename(file))) {
            return;
        }
        const connectionsPath = await findConnectionsFile(buildRoot);
        if (!connectionsPath || path.resolve(file) !== path.resolve(connectionsPath)) {
            return;
        }

        try {
            const { connectionIds } = await connectionRegistry.loadAndSetConnectionIds(
                async (id) => {
                    const result = await server.transformRequest(id);
                    return result?.code ?? null;
                },
            );
            log.debug(`Refreshed connection IDs from ${connectionsPath} (${connectionIds.length})`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.error(`Failed to refresh connection IDs: ${message}`);
        }
    },
});

const CONNECTIONS_BASENAME_RE = /^connections\.(?:ts|tsx|js|jsx)$/;
