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
import cp from 'child_process';
import fs from 'fs';
import { glob } from 'glob';
import modulePackage from 'module';
import path from 'path';
import dts from 'rollup-plugin-dts';
import esbuild from 'rollup-plugin-esbuild';

const CWD = process.env.PROJECT_CWD || process.cwd();
const ROLLUP_PLUGIN_PATH = 'rollup-plugin/dist-basic/src';
const BUNDLER_NAME_RX = /^@datadog\/(.+)-plugin$/g;

/**
 * @typedef {{
 *      module: string;
 *      main: string;
 *      name: string;
 *      peerDependencies: Record<string,string>;
 *      dependencies: Record<string,string>
 * }} PackageJson
 * @typedef {{ basic?: boolean }} BuildOptions
 * @typedef {import('rollup').InputPluginOption} InputPluginOption
 * @typedef {import('rollup').Plugin} Plugin
 * @typedef {import('@dd/core/types').Options} PluginOptions
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
 * Returns the base configuration for the build plugin in the context of this project.
 * @param {string} bundlerName
 * @param {string} buildName
 * @returns {PluginOptions}
 */
const getPluginConfig = (bundlerName, buildName) => {
    const cleanBuildName = buildName.toLowerCase().replace(/@/g, '').replace(/[ /:]/g, '-');
    const packageName = `${bundlerName}-plugin`;
    return {
        auth: {
            apiKey: process.env.DATADOG_API_KEY,
        },
        logLevel: 'debug',
        metadata: {
            name: buildName,
        },
        telemetry: {
            prefix: `build.rollup`,
            tags: [
                `build:${packageName}/${cleanBuildName}`,
                'service:build-plugins',
                `package:${packageName}`,
                `bundler:rollup`,
                `env:${process.env.BUILD_PLUGINS_ENV || 'development'}`,
                `sha:${process.env.GITHUB_SHA || 'local'}`,
                `ci:${process.env.CI ? 1 : 0}`,
            ],
            // NOTE: The current build is pretty small (2025-05-20). Keep an eye on the number of metrics submitted.
            filters: [],
            timestamp: Number(process.env.CI_PIPELINE_TIMESTAMP || Date.now()),
        },
    };
};

/**
 * Returns the rollup build plugin instance if necessary, null otherwise.
 * If the rollup plugin is not found, it will build it first.
 * @returns {Promise<any | null>}
 */
const getDatadogPlugin = async () => {
    if (!process.env.ADD_BUILD_PLUGINS) {
        return null;
    }
    try {
        // Verify the file exists.
        if (!fs.existsSync(path.join(CWD, 'packages/published', ROLLUP_PLUGIN_PATH, 'index.js'))) {
            console.log('@datadog/rollup-plugin not found, building it...');
            // Build the rollup plugin first.
            /** @type {Promise<void>} */
            const buildProm = new Promise((resolve) => {
                cp.exec('yarn workspace @datadog/rollup-plugin buildBasic', { cwd: CWD }, (err) => {
                    if (err) {
                        console.error('Failed to build @datadog/rollup-plugin', err);
                    }
                    // Do not block the build for this.
                    resolve();
                });
            });

            await buildProm;
        }
        // We need to target the built file because we don't have TS support for rollup's configuration (yet).
        // eslint-disable-next-line import/no-unresolved
        const { datadogRollupPlugin } = await import(`@datadog/${ROLLUP_PLUGIN_PATH}`);
        // Type casting because of the difference of type provenance.
        return datadogRollupPlugin;
    } catch (e) {
        console.log('Could not load @datadog/rollup-plugin, skipping.', e);
    }
    return null;
};

/**
 * @param {PackageJson} packageJson
 * @param {Partial<OutputOptions>} overrides
 * @param {BuildOptions} [options]
 * @returns {OutputOptions}
 */
const getOutput = (packageJson, overrides = {}, options) => {
    const filename = overrides.format === 'esm' ? packageJson.module : packageJson.main;
    const plugins = [terser()];

    // Inject ESM shims to support __dirname and co.
    if (overrides.format === 'esm') {
        plugins.push(esmShim());
    }

    const outDir = options?.basic
        ? path.dirname(filename).replace(/\/dist\//g, '/dist-basic/')
        : path.dirname(filename);

    return {
        exports: 'named',
        sourcemap: true,
        entryFileNames: `[name]${path.extname(filename)}`,
        dir: outDir,
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
 * @param {any | null} ddPlugin
 * @param {PackageJson} packageJson
 * @param {BuildOptions} [options]
 * @returns {Promise<RollupOptions[]>}
 */
export const getSubBuilds = async (ddPlugin, packageJson, options) => {
    const bundlerName = packageJson.name.replace(BUNDLER_NAME_RX, '$1');
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
                const outputs = (config.format ?? ['cjs']).map((format) =>
                    getOutput(
                        packageJson,
                        {
                            format,
                            sourcemap: false,
                            plugins: [terser({ mangle: true })],
                        },
                        options,
                    ),
                );
                const plugins = [esbuild()];
                if (ddPlugin) {
                    plugins.push(ddPlugin(getPluginConfig(bundlerName, name)));
                }
                return bundle(packageJson, {
                    plugins,
                    external: config.external,
                    input: {
                        [name]: path.join(CWD, path.dirname(pkg), config.entry),
                    },
                    output: outputs,
                });
            }),
        );
    }

    return subBuilds;
};

/**
 * @param {PackageJson} packageJson
 * @param {BuildOptions} [options]
 * @returns {Promise<RollupOptions[]>}
 */
export const getDefaultBuildConfigs = async (packageJson, options) => {
    const isBasicBuild = !!options?.basic;
    const ddPlugin = isBasicBuild ? null : await getDatadogPlugin();
    const bundlerName = packageJson.name.replace(BUNDLER_NAME_RX, '$1');

    // Plugins to use.
    const mainBundlePlugins = [esbuild()];
    const dtsBundlePlugins = [dts()];
    if (ddPlugin) {
        mainBundlePlugins.push(ddPlugin(getPluginConfig(bundlerName, packageJson.name)));
        dtsBundlePlugins.push(ddPlugin(getPluginConfig(bundlerName, `dts:${packageJson.name}`)));
    }

    // Sub builds.
    const subBuilds = await getSubBuilds(ddPlugin, packageJson, options);

    // Main bundle.
    const mainBundleOutputs = [getOutput(packageJson, { format: 'cjs' }, options)];
    if (!isBasicBuild) {
        mainBundleOutputs.push(getOutput(packageJson, { format: 'esm' }, options));
    }
    const mainBundleConfig = bundle(packageJson, {
        plugins: mainBundlePlugins,
        input: {
            index: 'src/index.ts',
        },
        output: mainBundleOutputs,
    });

    const configs = [mainBundleConfig, ...subBuilds];

    // Bundle type definitions.
    if (!isBasicBuild && !process.env.NO_TYPES) {
        configs.push(
            // FIXME: This build is sloooow.
            bundle(packageJson, {
                plugins: dtsBundlePlugins,
                output: {
                    dir: 'dist/src',
                },
            }),
        );
    }
    return configs;
};
