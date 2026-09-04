// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BuildOptions, InlineConfig, Plugin } from 'vite';

import { BACKEND_CODE_EXTENSIONS } from '../constants';

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
    plugins: Plugin[] = [],
): InlineConfig & {
    build: BuildOptions & { rollupOptions: NonNullable<BuildOptions['rollupOptions']> };
} {
    return {
        configFile: false,
        // configFile: false only skips loading a vite.config.js — it does NOT disable Vite's
        // separate .env-file/import.meta.env machinery. Without these two, Vite's own loadEnv()
        // copies any VITE_-prefixed key straight out of THIS PROCESS'S real, unscoped process.env
        // (independently of envFile, via its own `for (const key in process.env)` loop) and its
        // `define` plugin then statically inlines that value into the built backend function, at
        // build time — completely bypassing runWithScopedEnv's runtime scoping, which only wraps
        // module execution, never this bundling step. envPrefix: [] makes every such prefix check
        // false so nothing gets copied from process.env OR from a customer's own .env file in their
        // build root; envFile: false additionally skips reading that .env file at all, closing a
        // secondary path where its own values get variable-expanded against a full process.env copy.
        envFile: false,
        envPrefix: [],
        root,
        logLevel: 'silent',
        build: {
            minify: false,
            target: 'esnext',
            // Backend functions run server-side. Without this, Vite's default
            // browser-target build externalizes Node builtins (node:crypto, fs)
            // to a stub with no real exports.
            ssr: true,
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
            extensions: [...BACKEND_CODE_EXTENSIONS, '.json'],
        },
        // SSR mode externalizes node_modules deps by default, assuming a
        // server runtime can require() them at runtime. Backend bundles have
        // no such runtime available (sent in-memory or uploaded standalone),
        // so every dependency must be inlined instead.
        ssr: {
            noExternal: true,
        },
        plugins: [createVirtualPlugin('dd-backend-resolve', virtualEntries), ...plugins],
    };
}
