// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { datadogWebpackPlugin } from '@datadog/webpack-plugin';
import type { Options } from '@dd/core/types';
import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import type { BuildOptions } from 'esbuild';
import path from 'path';
import type { RollupOptions } from 'rollup';
import type { UserConfig } from 'vite';
import type { Configuration as Configuration4, Plugin } from 'webpack4';
import type { Configuration } from 'webpack';

import { defaultDestination, defaultEntry, defaultPluginOptions } from './mocks';

export const getWebpackOptions = (
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: Partial<Configuration> = {},
): Configuration => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    return {
        entry: defaultEntry,
        mode: 'production',
        output: {
            path: path.join(defaultDestination, 'webpack5'),
            filename: `[name].js`,
        },
        devtool: 'source-map',
        plugins: [datadogWebpackPlugin(newPluginOptions)],
        optimization: {
            minimize: false,
            splitChunks: {
                chunks: 'all',
                minSize: 1,
                minChunks: 1,
                name: (module: any, chunks: any, cacheGroupKey: string) => {
                    return `chunk.${cacheGroupKey}`;
                },
            },
        },
        ...bundlerOverrides,
    };
};

export const getWebpack4Options = (
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: Partial<Configuration4> = {},
): Configuration4 => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    const plugin = datadogWebpackPlugin(newPluginOptions) as unknown;
    const webpack5Config = getWebpackOptions(pluginOverrides);

    return {
        // Webpack4 doesn't support pnp resolution.
        entry: `./${path.relative(process.cwd(), require.resolve(defaultEntry))}`,
        mode: webpack5Config.mode,
        output: {
            ...(webpack5Config.output as Configuration4['output']),
            path: path.join(defaultDestination, 'webpack4'),
        },
        devtool: webpack5Config.devtool,
        plugins: [plugin as Plugin],
        node: false,
        optimization: webpack5Config.optimization as Configuration4['optimization'],
        ...bundlerOverrides,
    };
};

export const getEsbuildOptions = (
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: Partial<BuildOptions> = {},
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
        outdir: path.join(defaultDestination, 'esbuild'),
        plugins: [datadogEsbuildPlugin(newPluginOptions)],
        sourcemap: true,
        splitting: true,
        ...bundlerOverrides,
    };
};

export const getRollupOptions = (
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: Partial<RollupOptions> = {},
): RollupOptions => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    return {
        input: defaultEntry,
        plugins: [
            commonjs(),
            datadogRollupPlugin(newPluginOptions),
            nodeResolve({ preferBuiltins: true, browser: true }),
        ],
        output: {
            compact: false,
            dir: path.join(defaultDestination, 'rollup'),
            entryFileNames: '[name].js',
            chunkFileNames: 'chunk.[hash].js',
            sourcemap: true,
        },
        ...bundlerOverrides,
    };
};

export const getViteOptions = (
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: Partial<RollupOptions> = {},
): UserConfig => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    // Keep the same config as Rollup.
    const defaultRollupOptions = getRollupOptions(pluginOverrides, bundlerOverrides);

    return {
        build: {
            assetsDir: '', // Disable assets dir to simplify the test.
            minify: false,
            rollupOptions: {
                ...defaultRollupOptions,
                // Vite has its own set of plugins.
                plugins: [],
                output: {
                    ...defaultRollupOptions.output,
                    // Vite doesn't support dir output.
                    dir: path.join(defaultDestination, 'vite'),
                },
                ...bundlerOverrides,
            },
        },
        logLevel: 'silent',
        plugins: [datadogVitePlugin(newPluginOptions)],
    };
};
