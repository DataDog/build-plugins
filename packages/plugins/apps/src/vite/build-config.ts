// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BuildOptions, InlineConfig, Plugin } from 'vite';

/**
 * Create the virtual module resolver plugin used by both production and dev builds.
 * Maps virtual IDs to their generated source content.
 */
export function createVirtualPlugin(name: string, virtualEntries: Record<string, string>): Plugin {
    return {
        name,
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
    };
}

/**
 * Shared Vite/Rollup config for building backend functions.
 * Both the production build (write to disk) and dev build (in-memory)
 * use this as a base, overriding only what differs.
 */
export function getBaseBackendBuildConfig(
    root: string,
    virtualEntries: Record<string, string>,
): InlineConfig & {
    build: BuildOptions & { rollupOptions: NonNullable<BuildOptions['rollupOptions']> };
} {
    return {
        configFile: false,
        root,
        logLevel: 'silent',
        build: {
            minify: false,
            target: 'esnext',
            rollupOptions: {
                output: { format: 'es', exports: 'named', inlineDynamicImports: true },
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
        plugins: [createVirtualPlugin('dd-backend-resolve', virtualEntries)],
    };
}
