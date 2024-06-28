// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogWebpackPlugin } from '@datadog/webpack-plugin';
import type { GlobalContext, Options } from '@dd/core/types';
import esbuild from 'esbuild';
import path from 'path';
import webpack from 'webpack';

type BundlerOptions = {
    entry?: string;
    destination?: string;
};

export const defaultPluginOptions: Options = {
    auth: {
        apiKey: '123',
    },
    logLevel: 'debug',
};

export const getContextMock = (options: Partial<GlobalContext> = {}): GlobalContext => {
    return {
        auth: { apiKey: '123' },
        cwd: '/cwd/path',
        version: '1.2.3',
        bundler: { name: 'esbuild' },
        ...options,
    };
};

const getWebpackOptions = (
    pluginOptionOverrides: Options = {},
    bundlerOptions: BundlerOptions = {},
): webpack.Configuration => {
    const entry = bundlerOptions?.entry || defaultEntry;
    const destination = bundlerOptions?.destination || defaultDestination;

    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOptionOverrides,
    };

    return {
        entry,
        output: {
            path: path.join(destination, 'webpack'),
            filename: `[name].js`,
        },
        devtool: 'source-map',
        plugins: [datadogWebpackPlugin(newPluginOptions)],
    };
};

const getEsbuildOptions = (
    pluginOptionOverrides: Options = {},
    bundlerOptions: BundlerOptions = {},
): esbuild.BuildOptions => {
    const entry = bundlerOptions?.entry || defaultEntry;
    const destination = bundlerOptions?.destination || defaultDestination;

    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOptionOverrides,
    };

    return {
        bundle: true,
        sourcemap: true,
        entryPoints: [entry],
        outfile: path.join(destination, 'esbuild', 'index.js'),
        plugins: [datadogEsbuildPlugin(newPluginOptions)],
    };
};

export const defaultEntry = '@dd/tests/fixtures/index.js';
export const defaultDestination = path.resolve(__dirname, './dist');

export const runWebpack = async (
    pluginOptions: Options = {},
    bundlerOptions: BundlerOptions = {},
) => {
    const bundlerConfigs = getWebpackOptions(pluginOptions, bundlerOptions);
    return new Promise((resolve) => {
        webpack(bundlerConfigs, (err, stats) => {
            if (err) {
                console.log(err);
            }
            resolve(stats);
        });
    });
};

export const runEsbuild = async (
    pluginOptions: Options = {},
    bundlerOptions: BundlerOptions = {},
) => {
    const bundlerConfigs = getEsbuildOptions(pluginOptions, bundlerOptions);
    return esbuild.build(bundlerConfigs);
};

export const runBundlers = async (
    pluginOptions: Options = {},
    bundlerOptions: BundlerOptions = {},
) => {
    const promises = [];

    promises.push(runWebpack(pluginOptions, bundlerOptions));
    promises.push(runEsbuild(pluginOptions, bundlerOptions));

    const results = await Promise.all(promises);

    return results;
};
