// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, PluginOptions } from '@dd/core/types';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { RollupOutput } from 'rollup';

import type { BackendFunction } from '../discovery';
import type { BackendPluginContext } from '../index';
import { generateVirtualEntryContent } from '../virtual-entry';

const VIRTUAL_PREFIX = '\0dd-backend:';

/**
 * Build all backend functions using a separate vite.build() call.
 * Produces one standalone JS file per function in a temp directory.
 */
async function buildBackendFunctions(
    vite: any,
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

    const result = await vite.build({
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
                // Silence "use client" directive warnings from third-party deps.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onwarn(warning: any, defaultHandler: any) {
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

    const output = (Array.isArray(result) ? result[0] : result) as RollupOutput;

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

/**
 * Returns the Vite-specific plugin hooks for backend functions.
 * Uses a separate vite.build() for production instead of emitting chunks
 * into the host build, giving full control over backend build config.
 */
export const getVitePlugin = (
    functions: BackendFunction[],
    backendOutputs: Map<string, string>,
    log: Logger,
    pluginContext?: BackendPluginContext,
): PluginOptions['vite'] => {
    const vite = pluginContext?.bundler;

    const vitePlugin: PluginOptions['vite'] = {};

    // Production: run a separate vite.build() after the host build completes.
    if (vite) {
        vitePlugin.closeBundle = async () => {
            await buildBackendFunctions(
                vite,
                functions,
                backendOutputs,
                pluginContext!.buildRoot,
                log,
            );
        };
    }

    return vitePlugin;
};
