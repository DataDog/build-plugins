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
            path: path.join(defaultDestination, 'webpack'),
            filename: `[name].js`,
        },
        devtool: 'source-map',
        plugins: [datadogWebpackPlugin(newPluginOptions)],
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

    return {
        // Webpack4 doesn't support pnp resolution.
        entry: `./${path.relative(process.cwd(), require.resolve(defaultEntry))}`,
        mode: 'production',
        output: {
            path: path.join(defaultDestination, 'webpack'),
            filename: `[name].js`,
        },
        devtool: 'source-map',
        plugins: [plugin as Plugin],
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
        sourcemap: true,
        entryPoints: [defaultEntry],
        outfile: bundlerOverrides.outdir
            ? undefined
            : path.join(defaultDestination, 'esbuild', 'main.js'),
        plugins: [datadogEsbuildPlugin(newPluginOptions)],
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
        plugins: [datadogRollupPlugin(newPluginOptions), nodeResolve({ preferBuiltins: true })],
        output: {
            dir: path.join(defaultDestination, 'rollup'),
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

    return {
        build: {
            rollupOptions: getRollupOptions(pluginOverrides, {
                ...bundlerOverrides,
                output: {
                    dir: path.join(defaultDestination, 'vite'),
                },
                // Remove the build plugin from the rollup build.
                plugins: [nodeResolve({ preferBuiltins: true })],
            }),
        },
        logLevel: 'silent',
        plugins: [datadogVitePlugin(newPluginOptions)],
    };
};
