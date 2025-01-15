// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import babel from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import chalk from 'chalk';
import glob from 'glob';
import modulePackage from 'module';
import path from 'path';
import dts from 'rollup-plugin-dts';
import esbuild from 'rollup-plugin-esbuild';

const CWD = process.env.PROJECT_CWD;

/**
 * @param {{module: string; main: string;}} packageJson
 * @param {import('rollup').RollupOptions} config
 * @returns {import('rollup').RollupOptions}
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
        '@dd/core',
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
        ...config.plugins,
    ],
});

/**
 * @param {{module: string; main: string;}} packageJson
 * @param {Partial<import('rollup').OutputOptions>} overrides
 * @returns {import('rollup').OutputOptions}
 */
const getOutput = (packageJson, overrides = {}) => {
    const filename = overrides.format === 'esm' ? packageJson.module : packageJson.main;
    return {
        exports: 'named',
        sourcemap: true,
        entryFileNames: `[name]${path.extname(filename)}`,
        dir: path.dirname(filename),
        plugins: [terser()],
        format: 'cjs',
        // No chunks.
        manualChunks: () => '[name]',
        ...overrides,
    };
};

/**
 * @param {{module: string; main: string;}} packageJson
 * @returns {import('rollup').RollupOptions[]}
 */
export const getDefaultBuildConfigs = async (packageJson) => {
    // Verify if we have anything else to build from plugins.
    const pkgs = glob.sync('packages/plugins/**/package.json', { cwd: CWD });
    const pluginBuilds = [];
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

        pluginBuilds.push(
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
        ...pluginBuilds,
        // Bundle type definitions.
        // FIXME: This build is sloooow.
        // Check https://github.com/timocov/dts-bundle-generator
        bundle(packageJson, {
            plugins: [dts()],
            output: {
                dir: 'dist/src',
            },
        }),
    ];
    return configs;
};
