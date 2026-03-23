// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, PluginOptions } from '@dd/core/types';
import path from 'path';
import type { GetManualChunk, ManualChunksOption, OutputOptions } from 'rollup';

import type { BackendFunction } from './discovery';
import { BACKEND_VIRTUAL_PREFIX } from './index';

type BackendBundlerHooks = Pick<
    NonNullable<PluginOptions['rollup']>,
    'outputOptions' | 'buildStart' | 'writeBundle'
>;

export const getRollupPlugin = (
    functions: BackendFunction[],
    backendOutputs: Map<string, string>,
    log: Logger,
): BackendBundlerHooks => {
    /**
     * Wrap a user-provided manualChunks function to exclude backend modules
     * from being pulled into shared frontend chunks.
     */
    const wrapManualChunks = (original: GetManualChunk): ManualChunksOption => {
        return (id, api) => {
            const moduleInfo = api.getModuleInfo(id);
            if (moduleInfo) {
                const importers = moduleInfo.importers || [];
                if (importers.some((imp: string) => imp.startsWith(BACKEND_VIRTUAL_PREFIX))) {
                    return undefined;
                }
            }
            return original(id, api);
        };
    };

    const guardManualChunks = (output: OutputOptions) => {
        const original = output.manualChunks;
        if (typeof original === 'function') {
            output.manualChunks = wrapManualChunks(original);
        }
    };

    return {
        outputOptions(outputOptions) {
            // Guard user-configured manualChunks to prevent backend modules
            // from being pulled into shared frontend chunks.
            if (Array.isArray(outputOptions)) {
                for (const out of outputOptions) {
                    guardManualChunks(out);
                }
            } else if (outputOptions) {
                guardManualChunks(outputOptions);
            }
            return outputOptions;
        },
        buildStart() {
            for (const func of functions) {
                this.emitFile({
                    type: 'chunk',
                    id: `${BACKEND_VIRTUAL_PREFIX}${func.name}`,
                    name: `backend/${func.name}`,
                    preserveSignature: 'exports-only',
                });
            }
        },
        writeBundle(options, bundle) {
            const outDir = options.dir || path.dirname(options.file || '');
            for (const [fileName, chunk] of Object.entries(bundle)) {
                if (chunk.type !== 'chunk') {
                    continue;
                }
                if (
                    chunk.facadeModuleId &&
                    chunk.facadeModuleId.startsWith(BACKEND_VIRTUAL_PREFIX)
                ) {
                    const funcName = chunk.facadeModuleId.slice(BACKEND_VIRTUAL_PREFIX.length);
                    const absolutePath = path.resolve(outDir, fileName);
                    backendOutputs.set(funcName, absolutePath);
                    log.debug(`Backend function "${funcName}" output: ${absolutePath}`);
                }
            }
        },
    };
};
