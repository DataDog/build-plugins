// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import type { AuthOptionsWithDefaults, Logger, PluginOptions } from '@dd/core/types';
import path from 'path';
import type { build, ViteDevServer } from 'vite';

import type { BackendFunction } from '../backend/discovery';
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
}: VitePluginOptions): PluginOptions['vite'] => {
    // Captured from configureServer so buildStart can branch on dev vs build.
    // In `vite serve`, this.load returns a ModuleInfo whose `code` getter
    // throws — code is only resolvable through the dev server's transformRequest.
    let devServer: ViteDevServer | undefined;

    return {
        // Fires once per production build and once at dev-server start. In
        // `vite build --watch` it also re-fires when connections.ts changes
        // because addWatchFile registers it as a build dependency. In the dev
        // server, addWatchFile only registers chokidar tracking — buildStart
        // does NOT re-run on edits there; the dev-server watcher subscriptions
        // in configureServer refresh the registry on add/change/unlink (the
        // per-request nested viteBuild uses a different config without the
        // apps plugin, so its buildStart can't help).
        async buildStart() {
            connectionRegistry.setParse((code) => this.parse(code));
            try {
                const { filePath } = await connectionRegistry.loadAndSetConnectionIds(
                    async (id) => {
                        if (devServer) {
                            const result = await devServer.transformRequest(id);
                            return result?.code ?? null;
                        }
                        const info = await this.load({ id });
                        return info.code ?? null;
                    },
                );
                if (filePath) {
                    this.addWatchFile(filePath);
                }
            } catch (error) {
                // Surface the framed error before re-throwing — downstream
                // plugins (e.g. error-tracking's sourcemaps upload) may throw
                // their own errors during build teardown and mask ours from
                // vite's final error report.
                const message = error instanceof Error ? error.message : String(error);
                log.error(message);
                throw error;
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
            devServer = server;
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

            // Watch for connections-file lifecycle events. `handleHotUpdate`
            // only fires for updates to already-tracked files; it misses
            // creates and deletes. We subscribe to the underlying chokidar
            // watcher directly so create/change/unlink at the project root
            // all refresh (or clear) the registry — important because the
            // IDs are an allowlist and stale state could keep removed
            // connections allowed mid-session.
            const buildRootResolved = path.resolve(buildRoot);
            const isConnectionsFile = (filePath: string) =>
                CONNECTIONS_BASENAME_RE.test(path.basename(filePath)) &&
                path.resolve(path.dirname(filePath)) === buildRootResolved;

            const refresh = async (filePath: string) => {
                if (!isConnectionsFile(filePath)) {
                    return;
                }
                try {
                    const { filePath: resolved, connectionIds } =
                        await connectionRegistry.loadAndSetConnectionIds(async (id) => {
                            const result = await server.transformRequest(id);
                            return result?.code ?? null;
                        });
                    log.debug(
                        resolved
                            ? `Refreshed connection IDs from ${resolved} (${connectionIds.length})`
                            : 'Cleared connection IDs (no connections file present)',
                    );
                } catch (error) {
                    // Fail closed: an allowlist that silently retains
                    // removed UUIDs is more dangerous than one that
                    // temporarily denies everything until the file is fixed.
                    connectionRegistry.clearConnectionIds();
                    const message = error instanceof Error ? error.message : String(error);
                    log.error(`Failed to refresh connection IDs (cleared registry): ${message}`);
                }
            };

            server.watcher.on('add', refresh);
            server.watcher.on('change', refresh);
            server.watcher.on('unlink', refresh);
        },
    };
};

const CONNECTIONS_BASENAME_RE = /^connections\.(?:ts|tsx|js|jsx)$/;
