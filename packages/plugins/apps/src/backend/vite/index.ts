// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { AuthOptions, Logger, PluginOptions } from '@dd/core/types';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { build } from 'vite';

import type { BackendFunction } from '../discovery';
import { generateVirtualEntryContent } from '../virtual-entry';

import { createDevServerMiddleware } from './dev-server';

const VIRTUAL_PREFIX = '\0dd-backend:';

/**
 * Build all backend functions using a separate vite.build() call.
 * Produces one standalone JS file per function in a temp directory.
 */
async function buildBackendFunctions(
    viteBuild: typeof build,
    functions: BackendFunction[],
    backendOutputs: Map<string, string>,
    buildRoot: string,
    log: Logger,
): Promise<void> {
    const outDir = await mkdtemp(path.join(tmpdir(), 'dd-apps-backend-'));

    const virtualEntries: Record<string, string> = {};
    const input: Record<string, string> = {};

    for (const func of functions) {
        const virtualId = `${VIRTUAL_PREFIX}${func.name}`;
        virtualEntries[virtualId] = generateVirtualEntryContent(
            func.name,
            func.entryPath,
            buildRoot,
        );
        input[func.name] = virtualId;
    }

    log.debug(`Building ${functions.length} backend function(s) via vite.build()`);

    const result = await viteBuild({
        configFile: false,
        root: buildRoot,
        logLevel: 'silent',
        build: {
            write: true,
            outDir,
            emptyOutDir: false,
            minify: false,
            target: 'esnext',
            rollupOptions: {
                input,
                output: { format: 'es', exports: 'named', entryFileNames: '[name].js' },
                preserveEntrySignatures: 'exports-only',
                treeshake: false,
                onwarn(warning, defaultHandler) {
                    if (warning.code === 'MODULE_LEVEL_DIRECTIVE') {
                        return;
                    }
                    defaultHandler(warning);
                },
            },
        },
        resolve: {
            extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'],
        },
        plugins: [
            {
                name: 'dd-backend-resolve',
                enforce: 'pre',
                resolveId(id: string) {
                    if (virtualEntries[id]) {
                        return { id, moduleSideEffects: true };
                    }
                    return null;
                },
                load(id: string) {
                    if (virtualEntries[id]) {
                        return virtualEntries[id];
                    }
                    return null;
                },
            },
        ],
    });

    const output = Array.isArray(result) ? result[0] : result;

    // viteBuild always returns RolldownOutput here since we don't set build.watch.
    // RolldownWatcher would only be returned if watch mode were enabled.
    if ('output' in output) {
        for (const chunk of output.output) {
            if (chunk.type !== 'chunk' || !chunk.isEntry) {
                continue;
            }
            const funcName = chunk.name;
            const absolutePath = path.resolve(outDir, chunk.fileName);
            backendOutputs.set(funcName, absolutePath);
            log.debug(`Backend function "${funcName}" output: ${absolutePath}`);
        }
    }
}

export interface VitePluginOptions {
    viteBuild: typeof build;
    buildRoot: string;
    functions: BackendFunction[];
    backendOutputs: Map<string, string>;
    log: Logger;
    auth?: Required<AuthOptions>;
}

/**
 * Returns the Vite-specific plugin hooks for backend functions.
 * Uses a separate vite.build() for production instead of emitting chunks
 * into the host build, giving full control over backend build config.
 */
export const getVitePlugin = ({
    viteBuild,
    buildRoot,
    functions,
    backendOutputs,
    log,
    auth,
}: VitePluginOptions): PluginOptions['vite'] => {
    const vitePlugin: NonNullable<PluginOptions['vite']> = {
        // Production: run a separate vite.build() after the host build completes.
        async closeBundle() {
            await buildBackendFunctions(viteBuild, functions, backendOutputs, buildRoot, log);
        },
    };

    // Dev: register dev server middleware when auth is available.
    if (auth) {
        vitePlugin.configureServer = (server) => {
            server.middlewares.use(
                createDevServerMiddleware(viteBuild, functions, auth, buildRoot, log),
            );
        };
    }

    return vitePlugin;
};
