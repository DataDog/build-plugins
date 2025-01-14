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

import { getOutDir } from './env';
import { defaultEntry, defaultPluginOptions } from './mocks';
import type { BundlerOptionsOverrides } from './types';
import { getBaseXpackConfig, getWebpackPlugin } from './xpackConfigs';

export const getRspackOptions = (
    workingDir: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOptionsOverrides['rspack'] = {},
): RspackOptions => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    return {
        ...(getBaseXpackConfig(workingDir, 'rspack') as RspackOptions),
        plugins: [datadogRspackPlugin(newPluginOptions)],
        ...bundlerOverrides,
    };
};

export const getWebpack5Options = (
    workingDir: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOptionsOverrides['webpack5'] = {},
): Configuration => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    const plugin = getWebpackPlugin(newPluginOptions, webpack5);

    return {
        ...getBaseXpackConfig(workingDir, 'webpack5'),
        plugins: [plugin],
        ...bundlerOverrides,
    };
};

export const getWebpack4Options = (
    workingDir: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOptionsOverrides['webpack4'] = {},
): Configuration4 => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    const plugin = getWebpackPlugin(newPluginOptions, webpack4);

    return {
        ...getBaseXpackConfig(workingDir, 'webpack4'),
        plugins: [plugin as unknown as Plugin],
        node: false,
        ...bundlerOverrides,
    };
};

export const getEsbuildOptions = (
    workingDir: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOptionsOverrides['esbuild'] = {},
): BuildOptions => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    return {
        absWorkingDir: workingDir,
        bundle: true,
        chunkNames: 'chunk.[hash]',
        entryPoints: { main: defaultEntry },
        entryNames: '[name]',
        format: 'esm',
        outdir: getOutDir(workingDir, 'esbuild'),
        plugins: [datadogEsbuildPlugin(newPluginOptions)],
        sourcemap: true,
        splitting: true,
        ...bundlerOverrides,
    };
};

export const getRollupBaseConfig = (workingDir: string, bundlerName: string): RollupOptions => {
    const outDir = getOutDir(workingDir, bundlerName);
    return {
        input: path.resolve(workingDir, defaultEntry),
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
            dir: outDir,
            entryFileNames: '[name].js',
            sourcemap: true,
        },
    };
};

export const getRollupOptions = (
    workingDir: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOptionsOverrides['rollup'] = {},
): RollupOptions => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    const baseConfig = getRollupBaseConfig(workingDir, 'rollup');

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
    workingDir: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOptionsOverrides['vite'] = {},
): UserConfig => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    const baseConfig = getRollupBaseConfig(workingDir, 'vite');

    return {
        root: workingDir,
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
