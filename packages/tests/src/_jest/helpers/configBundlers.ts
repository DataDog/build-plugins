// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogRspackPlugin } from '@datadog/rspack-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import type { Options } from '@dd/core/types';
import {
    configEsbuild,
    configRollup,
    configRspack,
    configVite,
    configWebpack4,
    configWebpack5,
} from '@dd/tools/bundlers';
import type { RspackOptions } from '@rspack/core';
import type { BuildOptions } from 'esbuild';
import path from 'path';
import type { RollupOptions } from 'rollup';
import type { UserConfig } from 'vite';
import type { Configuration as Configuration4 } from 'webpack4';
import webpack4 from 'webpack4';
import type { Configuration } from 'webpack5';
import webpack5 from 'webpack5';

import { getOutDir } from './env';
import { getWebpackPlugin } from './getWebpackPlugin';
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
        ...configWebpack5({
            workingDir,
            entry: { main: path.resolve(workingDir, defaultEntry) },
            outDir: getOutDir(workingDir, 'webpack5'),
            plugins: [plugin],
        }),
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
        ...configWebpack4({
            workingDir,
            entry: { main: path.resolve(workingDir, defaultEntry) },
            outDir: getOutDir(workingDir, 'webpack4'),
            plugins: [plugin],
        }),
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
