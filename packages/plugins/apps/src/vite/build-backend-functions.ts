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

    log.debug(`Building ${functions.length} backend function(s) via vite.build()`);

    // Build each function individually so that each output is a single
    // self-contained JS file
    for (const func of functions) {
        const virtualId = `${VIRTUAL_PREFIX}${func.name}`;
        const virtualContent = generateVirtualEntryContent(func.name, func.entryPath, buildRoot);

        const baseConfig = getBaseBackendBuildConfig(buildRoot, { [virtualId]: virtualContent });

        // eslint-disable-next-line no-await-in-loop
        const result = await viteBuild({
            ...baseConfig,
            build: {
                ...baseConfig.build,
                write: true,
                outDir,
                emptyOutDir: false,
                rollupOptions: {
                    ...baseConfig.build.rollupOptions,
                    input: { [func.name]: virtualId },
                    output: {
                        ...baseConfig.build.rollupOptions.output,
                        entryFileNames: '[name].js',
                    },
                },
            },
        });

        const output = Array.isArray(result) ? result[0] : result;

        if ('output' in output) {
            for (const chunk of output.output) {
                if (chunk.type !== 'chunk' || !chunk.isEntry) {
                    continue;
                }
                const absolutePath = path.resolve(outDir, chunk.fileName);
                backendOutputs.set(func.name, absolutePath);
                log.debug(`Backend function "${func.name}" output: ${absolutePath}`);
            }
        }
    }

    return outDir;
}
