// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { build } from 'vite';

import type { BackendFunction } from '../backend/discovery';
import { generateVirtualEntryContent } from '../backend/virtual-entry';

import { getBaseBackendBuildConfig } from './build-config';

const VIRTUAL_PREFIX = '\0dd-backend:';

/**
 * Build all backend functions using a separate vite.build() call.
 * Produces one standalone JS file per function in a temp directory.
 */
export async function buildBackendFunctions(
    viteBuild: typeof build,
    functions: BackendFunction[],
    backendOutputs: Map<string, string>,
    buildRoot: string,
    log: Logger,
): Promise<string> {
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

    const baseConfig = getBaseBackendBuildConfig(buildRoot, virtualEntries);

    // Production: build all functions in one vite.build() call, writing each to
    // disk as a named file so the archive/upload step can collect them.
    // Uses multi-entry input (one per function) with \0-prefixed virtual IDs —
    // the \0 convention prevents other plugins from processing these IDs.
    const result = await viteBuild({
        ...baseConfig,
        build: {
            ...baseConfig.build,
            write: true,
            outDir,
            emptyOutDir: false,
            rollupOptions: {
                ...baseConfig.build.rollupOptions,
                input,
                output: { ...baseConfig.build.rollupOptions.output, entryFileNames: '[name].js' },
            },
        },
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

    return outDir;
}
