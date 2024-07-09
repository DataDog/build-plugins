// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { datadogWebpackPlugin } from '@datadog/webpack-plugin';
import type { Options } from '@dd/core/types';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import type { BuildOptions } from 'esbuild';
import path from 'path';
import type { RollupOptions } from 'rollup';
import type { UserConfig } from 'vite';
import type { Configuration as Configuration4, Plugin } from 'webpack4';
import type { Configuration } from 'webpack';

import { defaultDestination, defaultEntry, defaultPluginOptions } from './mocks';

export const getWebpackOptions = (
    pluginOptionOverrides: Options = {},
    bundlerOptions: Partial<Configuration> = {},
): Configuration => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOptionOverrides,
    };

    return {
        entry: defaultEntry,
        mode: 'production',
        output: {
            path: path.join(defaultDestination, 'webpack'),
            filename: `[name].js`,
        },
        devtool: 'source-map',
        plugins: [datadogWebpackPlugin(newPluginOptions)],
        ...bundlerOptions,
    };
};

export const getWebpack4Options = (
    pluginOptionOverrides: Options = {},
    bundlerOptions: Partial<Configuration4> = {},
): Configuration4 => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOptionOverrides,
    };

    const plugin = datadogWebpackPlugin(newPluginOptions) as unknown;

    return {
        // Somehow webpack4 doesn't find @dd/tests/fixtures/index.js
        entry: './src/fixtures/index.js',
        output: {
            path: path.join(defaultDestination, 'webpack'),
            filename: `[name].js`,
        },
        devtool: 'source-map',
        plugins: [plugin as Plugin],
        ...bundlerOptions,
    };
};

export const getEsbuildOptions = (
    pluginOptionOverrides: Options = {},
    bundlerOptions: Partial<BuildOptions> = {},
): BuildOptions => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOptionOverrides,
    };

    return {
        bundle: true,
        sourcemap: true,
        entryPoints: [defaultEntry],
        outfile: bundlerOptions.outdir
            ? undefined
            : path.join(defaultDestination, 'esbuild', 'main.js'),
        plugins: [datadogEsbuildPlugin(newPluginOptions)],
        ...bundlerOptions,
    };
};

export const getRollupOptions = (
    pluginOptionOverrides: Options = {},
    bundlerOptions: Partial<RollupOptions> = {},
): RollupOptions => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOptionOverrides,
    };

    return {
        input: defaultEntry,
        plugins: [datadogRollupPlugin(newPluginOptions), nodeResolve({ preferBuiltins: true })],
        output: {
            dir: path.join(defaultDestination, 'rollup'),
        },
        ...bundlerOptions,
    };
};

export const getViteOptions = (
    pluginOptionOverrides: Options = {},
    bundlerOptions: Partial<RollupOptions> = {},
): UserConfig => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOptionOverrides,
    };

    return {
        build: {
            rollupOptions: getRollupOptions(pluginOptionOverrides, bundlerOptions),
        },
        plugins: [datadogVitePlugin(newPluginOptions)],
    };
};
