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
        root,
        logLevel: 'silent',
        build: {
            minify: false,
            target: 'esnext',
            // Backend functions run server-side, never in a browser. Without
            // this, Vite defaults to a browser-target build and externalizes
            // real Node builtin imports (node:crypto, fs, etc.) to a
            // `__vite-browser-external:*` stub with no real exports, silently
            // breaking any backend function that imports one directly.
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
        // Vite's SSR build mode (enabled above) externalizes any real npm
        // dependency it finds in node_modules by default, on the assumption
        // a server runtime can `require()` it at runtime. Backend-function
        // bundles don't get that guarantee: dev-server.ts writes them to a
        // standalone temp file, and the local-execution path imports the
        // bundle from a data: URL with no filesystem context at all -- so
        // every real dependency must be inlined, matching the pre-ssr:true
        // browser-mode behavior this config otherwise replaces.
        ssr: {
            noExternal: true,
        },
        plugins: [createVirtualPlugin('dd-backend-resolve', virtualEntries), ...plugins],
    };
}
