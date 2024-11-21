// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogRspackPlugin } from '@datadog/rspack-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import type { Options } from '@dd/core/types';
import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import type { RspackOptions } from '@rspack/core';
import type { BuildOptions } from 'esbuild';
import path from 'path';
import type { RollupOptions } from 'rollup';
import type { UserConfig } from 'vite';
import type { Configuration as Configuration4, Plugin } from 'webpack4';
import webpack4 from 'webpack4';
import type { Configuration } from 'webpack5';
import webpack5 from 'webpack5';

import { defaultDestination, defaultEntry, defaultPluginOptions } from './mocks';
import type { BundlerOverrides } from './types';
import { getBaseXpackConfig, getWebpack4Entries, getWebpackPlugin } from './xpackConfigs';

export const getRspackOptions = (
    seed: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOverrides['rspack'] = {},
): RspackOptions => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    return {
        ...(getBaseXpackConfig(seed, 'rspack') as RspackOptions),
        plugins: [datadogRspackPlugin(newPluginOptions)],
        ...bundlerOverrides,
    };
};

export const getWebpack5Options = (
    seed: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOverrides['webpack5'] = {},
): Configuration => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    const plugin = getWebpackPlugin(newPluginOptions, webpack5);

    return {
        ...getBaseXpackConfig(seed, 'webpack5'),
        plugins: [plugin],
        ...bundlerOverrides,
    };
};

export const getWebpack4Options = (
    seed: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOverrides['webpack4'] = {},
): Configuration4 => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    const plugin = getWebpackPlugin(newPluginOptions, webpack4);

    return {
        ...getBaseXpackConfig(seed, 'webpack4'),
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
