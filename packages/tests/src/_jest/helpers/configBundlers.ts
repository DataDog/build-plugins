// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogRspackPlugin } from '@datadog/rspack-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { datadogWebpackPlugin } from '@datadog/webpack-plugin';
import type { Options } from '@dd/core/types';
import {
    configEsbuild,
    configRollup,
    configRspack,
    configVite,
    configWebpack,
} from '@dd/tools/bundlers';
import type { RspackOptions } from '@rspack/core';
import type { BuildOptions } from 'esbuild';
import path from 'path';
import type { RollupOptions } from 'rollup';
import type { UserConfig } from 'vite';
import type { Configuration } from 'webpack';

import { getOutDir } from './env';
import { defaultEntry, defaultPluginOptions } from './mocks';
import type { BundlerOptionsOverrides } from './types';

export const getRspackOptions = (
    workingDir: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOptionsOverrides['rspack'] = {},
): RspackOptions => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    const plugin = datadogRspackPlugin(newPluginOptions);

    return {
        ...configRspack({
            workingDir,
            entry: { main: path.resolve(workingDir, defaultEntry) },
            outDir: getOutDir(workingDir, 'rspack'),
            plugins: [plugin],
        }),
        ...bundlerOverrides,
    };
};

export const getWebpackOptions = (
    workingDir: string,
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: BundlerOptionsOverrides['webpack'] = {},
): Configuration => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOverrides,
    };

    return {
        ...configWebpack({
            workingDir,
            entry: { main: path.resolve(workingDir, defaultEntry) },
            outDir: getOutDir(workingDir, 'webpack5'),
            plugins: [datadogWebpackPlugin(newPluginOptions)],
        }),
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
        ...configEsbuild({
            workingDir,
            entry: { main: defaultEntry },
            outDir: getOutDir(workingDir, 'esbuild'),
            plugins: [datadogEsbuildPlugin(newPluginOptions)],
        }),
        format: 'esm',
        splitting: true,
        ...bundlerOverrides,
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

    const baseConfig = configRollup({
        workingDir,
        entry: { main: defaultEntry },
        outDir: getOutDir(workingDir, 'rollup'),
        plugins: [datadogRollupPlugin(newPluginOptions)],
    });

    return {
        ...baseConfig,
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

    const baseConfig = configVite({
        workingDir,
        entry: { main: defaultEntry },
        outDir: getOutDir(workingDir, 'vite'),
        plugins: [datadogVitePlugin(newPluginOptions)],
    });

    return {
        root: workingDir,
        ...baseConfig,
        build: {
            ...baseConfig.build,
            rollupOptions: {
                ...baseConfig.build?.rollupOptions,
                ...bundlerOverrides,
                output: {
                    ...baseConfig.build?.rollupOptions?.output,
                    ...bundlerOverrides.output,
                },
            },
        },
    };
};
