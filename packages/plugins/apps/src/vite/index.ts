// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, PluginOptions } from '@dd/core/types';
import { rm } from 'fs/promises';
import type { build } from 'vite';

import type { BackendFunction } from '../backend/discovery';

import { buildBackendFunctions } from './build-backend-functions';

export interface VitePluginOptions {
    viteBuild: typeof build;
    buildRoot: string;
    functions: BackendFunction[];
    backendOutputs: Map<string, string>;
    handleUpload: () => Promise<void>;
    log: Logger;
}

/**
 * Returns the Vite-specific plugin hooks for the apps plugin.
 *
 * Builds backend functions (if any) then uploads all assets sequentially
 * inside closeBundle. Because closeBundle is async-parallel in Rollup/Vite,
 * both operations must live in the same callback to guarantee ordering.
 */
export const getVitePlugin = ({
    viteBuild,
    buildRoot,
    functions,
    backendOutputs,
    handleUpload,
    log,
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
                await rm(backendOutDir, { recursive: true, force: true });
            }
        }
    },
});
