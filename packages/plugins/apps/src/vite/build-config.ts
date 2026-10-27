// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BuildOptions, InlineConfig, Plugin } from 'vite';

import { BACKEND_RUNTIME_PACKAGES } from '../backend/shared';
import { BACKEND_CODE_EXTENSIONS } from '../constants';

// Rolldown (Vite 8) output option that keeps function and class names when minifying. Rollup's
// types don't declare it, and Rollup-based Vite ignores it, so it is spread in rather than typed.
const ROLLDOWN_KEEP_NAMES = { keepNames: true } satisfies Record<string, unknown>;

export const DEV_PROD_CONDITION = 'development|production';

type BaseBackendBuildConfig = ReturnType<typeof getBaseBackendBuildConfig>;

/**
 * Vite takes export conditions, `import.meta.env.DEV`/`PROD` and the JSX dev transform from
 * `process.env.NODE_ENV`, which a dev server sets to development. Pinning them makes a bundle built
 * there match a `vite build` upload, which runs under production. `serverConditions` is Vite's
 * `defaultServerConditions`, which Vite 5 doesn't export; no option pins its missing-peer stub.
 */
export function withProductionSettings(
    config: BaseBackendBuildConfig,
    serverConditions: readonly string[] | undefined,
): BaseBackendBuildConfig {
    const conditions = serverConditions?.map((condition) =>
        condition === DEV_PROD_CONDITION ? 'production' : condition,
    );
    const resolve = conditions && { resolve: { ...config.ssr?.resolve, conditions } };
    return {
        ...config,
        define: {
            ...config.define,
            'import.meta.env.DEV': 'false',
            'import.meta.env.PROD': 'true',
        },
        // Vite 8 converts esbuild options to Oxc's, jsxDev included.
        esbuild: { ...config.esbuild, jsxDev: false },
        ssr: { ...config.ssr, ...resolve },
    };
}

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
 * Shared Vite/Rollup config for the backend bundles Datadog runs: uploads (written to disk) and
 * dev-server cloud execution (in memory, through `withProductionSettings`), so both build alike.
 * Local execution imports the source directly and never builds with it.
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
        // configFile: false only skips loading a vite.config.js — it does not disable Vite's
        // separate .env-file/import.meta.env machinery, which otherwise copies any VITE_-prefixed
        // key straight out of the real process.env and statically inlines it into the built
        // backend function. envPrefix: [] blocks that copy; envFile: false additionally stops a
        // secret set only in the build root's own .env file from being read at all.
        envFile: false,
        envPrefix: [],
        root,
        logLevel: 'silent',
        // Names stay readable in function-log stack frames and to code reading `.name`. esbuild
        // (before Vite 8) and Oxc (Vite 8) each read only their own keepNames option.
        esbuild: { keepNames: true },
        build: {
            // Not 'esbuild', which Vite 8 (Rolldown) loads only if the app installs it.
            minify: true,
            target: 'esnext',
            // Backend functions run server-side. Without this, Vite's default
            // browser-target build externalizes Node builtins (node:crypto, fs)
            // to a stub with no real exports.
            ssr: true,
            rollupOptions: {
                output: {
                    format: 'es',
                    exports: 'named',
                    inlineDynamicImports: true,
                    ...ROLLDOWN_KEEP_NAMES,
                },
                preserveEntrySignatures: 'exports-only',
                // Each exported function is bundled separately, so without tree-shaking every
                // bundle carries the whole import graph of its `.backend.ts` file, including code
                // only sibling exports use. Standard tree-shaking keeps modules' top-level side
                // effects, honoring packages' `"sideEffects"` field like the frontend build does.
                treeshake: true,
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
            // The virtual entry initializes these runtimes on the copy resolved from the root, so
            // a package providing backend functions must reach that same copy even when it's
            // linked from a location with its own copy installed.
            dedupe: [...BACKEND_RUNTIME_PACKAGES],
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
