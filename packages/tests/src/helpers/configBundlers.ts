// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { datadogWebpackPlugin } from '@datadog/webpack-plugin';
import { getResolvedPath } from '@dd/core/helpers';
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

const getBaseWebpackConfig = (seed: string, bundlerName: string): Configuration => {
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
                chunks: 'all',
                minSize: 1,
                minChunks: 1,
                name: (module: any, chunks: any, cacheGroupKey: string) => {
                    return `chunk.${cacheGroupKey}`;
                },
            },
        },
    };
};

export const getWebpack5Options = (
    seed: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: Partial<Configuration> = {},
): Configuration => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    const plugin = datadogWebpackPlugin(newPluginOptions);

    return {
        ...getBaseWebpackConfig(seed, 'webpack5'),
        plugins: [plugin],
        ...bundlerOverrides,
    };
};

export const getWebpack4Options = (
    seed: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: Partial<Configuration4> = {},
): Configuration4 => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    const plugin = datadogWebpackPlugin(newPluginOptions);

    return {
        ...(getBaseWebpackConfig(seed, 'webpack4') as Configuration4),
        // Webpack4 doesn't support pnp resolution.
        entry: `./${path.relative(process.cwd(), getResolvedPath(defaultEntry))}`,
        plugins: [plugin as unknown as Plugin],
        node: false,
        ...bundlerOverrides,
    };
};

export const getEsbuildOptions = (
    seed: string,
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
        outdir: path.join(defaultDestination, seed, 'esbuild'),
        plugins: [datadogEsbuildPlugin(newPluginOptions)],
        sourcemap: true,
        splitting: true,
        ...bundlerOverrides,
    };
};

export const getRollupOptions = (
    seed: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: Partial<RollupOptions> = {},
): RollupOptions => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    return {
        input: defaultEntry,
        onwarn: (warning, handler) => {
            if (!/Circular dependency:/.test(warning.message)) {
                return handler(warning);
            }
        },
        plugins: [
            commonjs(),
            datadogRollupPlugin(newPluginOptions),
            nodeResolve({ preferBuiltins: true, browser: true }),
        ],
        output: {
            compact: false,
            dir: path.join(defaultDestination, seed, 'rollup'),
            entryFileNames: '[name].js',
            chunkFileNames: 'chunk.[hash].js',
            sourcemap: true,
        },
        ...bundlerOverrides,
    };
};

export const getViteOptions = (
    seed: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: Partial<RollupOptions> = {},
): UserConfig => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    return {
        build: {
            assetsDir: '', // Disable assets dir to simplify the test.
            minify: false,
            rollupOptions: {
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
                    compact: false,
                    // Vite doesn't support dir output.
                    dir: path.join(defaultDestination, seed, 'vite'),
                    entryFileNames: '[name].js',
                    chunkFileNames: 'chunk.[hash].js',
                    sourcemap: true,
                },
                ...bundlerOverrides,
            },
        },
        logLevel: 'silent',
        plugins: [datadogVitePlugin(newPluginOptions)],
    };
};
