// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// @ts-check

import babel from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';
import esmShim from '@rollup/plugin-esm-shim';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import chalk from 'chalk';
import glob from 'glob';
import modulePackage from 'module';
import path from 'path';
import dts from 'rollup-plugin-dts';
import esbuild from 'rollup-plugin-esbuild';

const CWD = process.env.PROJECT_CWD || process.cwd();

/**
 * @typedef {{
 *      module: string;
 *      main: string;
 *      name: string;
 *      peerDependencies: Record<string,string>;
 *      dependencies: Record<string,string>
 * }} PackageJson
 * @typedef {import('rollup').InputPluginOption} InputPluginOption
 * @typedef {import('rollup').Plugin} Plugin
 * @typedef {import('@dd/core/types').Assign<
 *      import('rollup').RollupOptions,
 *      {
 *         external?: string[];
 *         plugins?: InputPluginOption[];
 *      }
 * >} RollupOptions
 * @typedef {import('rollup').OutputOptions} OutputOptions
 */

/**
 * @param {PackageJson} packageJson
 * @param {RollupOptions} config
 * @returns {RollupOptions}
 */
export const bundle = (packageJson, config) => ({
    input: 'src/index.ts',
    ...config,
    external: [
        // All peer dependencies are external dependencies.
        ...Object.keys(packageJson.peerDependencies),
        // All dependencies are external dependencies.
        ...Object.keys(packageJson.dependencies),
        // These should be internal only and never be anywhere published.
        '@dd/tools',
        '@dd/tests',
        // We never want to include Node.js built-in modules in the bundle.
        ...modulePackage.builtinModules,
        ...(config.external || []),
    ],
    onwarn(warning, warn) {
        // Ignore warnings about undefined `this`.
        if (warning.code === 'THIS_IS_UNDEFINED') {
            return;
        }
        warn(warning);
    },
    plugins: [
        babel({
            babelHelpers: 'bundled',
            include: ['src/**/*'],
        }),
        json(),
        commonjs(),
        nodeResolve({ preferBuiltins: true }),
        ...(config.plugins || []),
    ],
});

/**
 * @param {PackageJson} packageJson
 * @param {Partial<OutputOptions>} overrides
 * @returns {OutputOptions}
 */
const getOutput = (packageJson, overrides = {}) => {
    const filename = overrides.format === 'esm' ? packageJson.module : packageJson.main;
    const plugins = [terser()];

    // Inject ESM shims to support __dirname and co.
    if (overrides.format === 'esm') {
        plugins.push(esmShim());
    }

    return {
        exports: 'named',
        sourcemap: true,
        entryFileNames: `[name]${path.extname(filename)}`,
        dir: path.dirname(filename),
        plugins,
        format: 'cjs',
        globals: {
            globalThis: 'window',
        },
        // No chunks.
        manualChunks: () => '[name]',
        ...overrides,
    };
};

/**
 * @param {PackageJson} packageJson
 * @returns {Promise<RollupOptions[]>}
 */
export const getDefaultBuildConfigs = async (packageJson) => {
    // Verify if we have anything else to build from plugins.
    const pkgs = glob.sync('packages/plugins/**/package.json', { cwd: CWD });
    const subBuilds = [];
    for (const pkg of pkgs) {
        const { default: content } = await import(path.resolve(CWD, pkg), {
            assert: { type: 'json' },
        });

        if (!content.toBuild) {
            continue;
        }

        console.log(
            `Will also build ${chalk.green.bold(content.name)} additional files: ${chalk.green.bold(Object.keys(content.toBuild).join(', '))}`,
        );

        subBuilds.push(
            ...Object.entries(content.toBuild).map(([name, config]) => {
                return bundle(packageJson, {
                    plugins: [esbuild()],
                    external: config.external,
                    input: {
                        [name]: path.join(CWD, path.dirname(pkg), config.entry),
                    },
                    output: [
                        getOutput(packageJson, {
                            format: 'cjs',
                            sourcemap: false,
                            plugins: [terser({ mangle: true })],
                        }),
                    ],
                });
            }),
        );
    }

    const configs = [
        // Main bundle.
        bundle(packageJson, {
            plugins: [esbuild()],
            input: {
                index: 'src/index.ts',
            },
            output: [
                getOutput(packageJson, { format: 'esm' }),
                getOutput(packageJson, { format: 'cjs' }),
            ],
        }),
        ...subBuilds,
        // Bundle type definitions.
        // FIXME: This build is sloooow.
        bundle(packageJson, {
            plugins: [dts()],
            output: {
                dir: 'dist/src',
            },
        }),
    ];
    return configs;
};
