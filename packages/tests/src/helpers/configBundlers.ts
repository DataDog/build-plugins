// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { getResolvedPath } from '@dd/core/helpers';
import type { Options } from '@dd/core/types';
import { buildPluginFactory } from '@dd/factory';
import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import type { BuildOptions } from 'esbuild';
import path from 'path';
import type { RollupOptions } from 'rollup';
import type { UserConfig } from 'vite';
import type { Configuration as Configuration4, Plugin } from 'webpack4';
import webpack4 from 'webpack4';
import type { Configuration } from 'webpack';
import webpack5 from 'webpack';

import { PLUGIN_VERSIONS } from './constants';
import { defaultDestination, defaultEntry, defaultPluginOptions } from './mocks';
import type { BundlerOverrides } from './types';

export const getBaseWebpackConfig = (seed: string, bundlerName: string): Configuration => {
    return {
        entry: defaultEntry,
        mode: 'production',
        output: {
            path: path.join(defaultDestination, seed, bundlerName),
            filename: `[name].js`,
        },
        devtool: 'source-map',
        optimization: {
            minimize: false,
            splitChunks: {
                chunks: 'initial',
                minSize: 1,
                minChunks: 1,
                name: (module: any, chunks: any, cacheGroupKey: string) => {
                    return `chunk.${cacheGroupKey}`;
                },
            },
        },
    };
};

export const getWebpack5Options = async (
    seed: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOverrides['webpack5'] = {},
): Promise<Configuration> => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    // const { datadogWebpackPlugin } = await import('@datadog/webpack-plugin');
    // const plugin = datadogWebpackPlugin(newPluginOptions);

    // Need to use the factory directly since we pass the bundler in the factory.
    const plugin = buildPluginFactory({
        bundler: webpack5,
        version: PLUGIN_VERSIONS.webpack,
    }).webpack(newPluginOptions);

    return {
        ...getBaseWebpackConfig(seed, 'webpack5'),
        plugins: [plugin],
        ...bundlerOverrides,
    };
};

// Webpack 4 doesn't support pnp resolution OOTB.
export const getWebpack4Entries = (
    entries: string | Record<string, string>,
    cwd: string = process.cwd(),
) => {
    const getTrueRelativePath = (filepath: string) => {
        return `./${path.relative(cwd, getResolvedPath(filepath))}`;
    };

    if (typeof entries === 'string') {
        return getTrueRelativePath(entries);
    }

    return Object.fromEntries(
        Object.entries(entries).map(([name, filepath]) => [name, getTrueRelativePath(filepath)]),
    );
};

export const getWebpack4Options = async (
    seed: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOverrides['webpack4'] = {},
): Promise<Configuration4> => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    // const { datadogWebpackPlugin } = await import('@datadog/webpack-plugin');
    // const plugin = datadogWebpackPlugin(newPluginOptions);

    // Need to use the factory directly since we pass the bundler in the factory.
    const plugin = buildPluginFactory({
        bundler: webpack4,
        version: PLUGIN_VERSIONS.webpack,
    }).webpack(newPluginOptions);

    return {
        ...(getBaseWebpackConfig(seed, 'webpack4') as Configuration4),
        entry: getWebpack4Entries(defaultEntry),
        plugins: [plugin as unknown as Plugin],
        node: false,
        ...bundlerOverrides,
    };
};

export const getEsbuildOptions = (
    seed: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOverrides['esbuild'] = {},
): BuildOptions => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    return {
        bundle: true,
        chunkNames: 'chunk.[hash]',
        entryPoints: { main: defaultEntry },
        entryNames: '[name]',
        format: 'esm',
        outdir: path.join(defaultDestination, seed, 'esbuild'),
        plugins: [datadogEsbuildPlugin(newPluginOptions)],
        sourcemap: true,
        splitting: true,
        ...bundlerOverrides,
    };
};

export const getRollupBaseConfig = (seed: string, bundlerName: string): RollupOptions => {
    return {
        input: defaultEntry,
        onwarn: (warning, handler) => {
            if (
                !/Circular dependency:/.test(warning.message) &&
                !/Sourcemap is likely to be incorrect/.test(warning.message)
            ) {
                return handler(warning);
            }
        },
        output: {
            chunkFileNames: 'chunk.[hash].js',
            compact: false,
            dir: path.join(defaultDestination, seed, bundlerName),
            entryFileNames: '[name].js',
            sourcemap: true,
        },
    };
};

export const getRollupOptions = (
    seed: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOverrides['rollup'] = {},
): RollupOptions => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    const baseConfig = getRollupBaseConfig(seed, 'rollup');

    return {
        ...baseConfig,
        plugins: [
            commonjs(),
            datadogRollupPlugin(newPluginOptions),
            nodeResolve({ preferBuiltins: true, browser: true }),
        ],
        ...bundlerOverrides,
        output: {
            ...baseConfig.output,
            ...bundlerOverrides.output,
        },
    };
};

export const getViteOptions = (
    seed: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOverrides['vite'] = {},
): UserConfig => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    const baseConfig = getRollupBaseConfig(seed, 'vite');

    return {
        build: {
            assetsDir: '', // Disable assets dir to simplify the test.
            minify: false,
            rollupOptions: {
                ...baseConfig,
                ...bundlerOverrides,
                output: {
                    ...baseConfig.output,
                    ...bundlerOverrides.output,
                },
            },
        },
        logLevel: 'silent',
        plugins: [datadogVitePlugin(newPluginOptions)],
    };
};
