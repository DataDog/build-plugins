// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogWebpackPlugin } from '@datadog/webpack-plugin';
import type { Options } from '@dd/factory';
import esbuild from 'esbuild';
import path from 'path';
import webpack from 'webpack';

type BundlerOptions = {
    entry: string;
    destination: string;
};

const defaultPluginOptions: Options = {
    auth: {
        apiKey: '',
    },
    logLevel: 'debug',
};

const getBundlerOptions = (
    { entry, destination }: BundlerOptions,
    pluginOptionOverrides: Options = {},
) => {
    const newPluginOptions = {
        ...defaultPluginOptions,
        ...pluginOptionOverrides,
    };
    // Bundler configs.
    const esbuildConfig: esbuild.BuildOptions = {
        bundle: true,
        sourcemap: true,
        entryPoints: [entry],
        outfile: path.join(destination, 'esbuild', 'index.js'),
        plugins: [datadogEsbuildPlugin(newPluginOptions)],
    };

    const configWebpack: webpack.Configuration = {
        entry,
        output: {
            path: path.join(destination, 'webpack'),
            filename: `[name].js`,
        },
        devtool: 'source-map',
        plugins: [datadogWebpackPlugin(newPluginOptions)],
    };

    return {
        webpack: configWebpack,
        esbuild: esbuildConfig,
    };
};

export const runBundlers = async (bundlerOptions: BundlerOptions, pluginOptions?: Options) => {
    const promises = [];
    const bundlerConfigs = getBundlerOptions(bundlerOptions, pluginOptions);
    promises.push(
        new Promise((resolve) => {
            webpack(bundlerConfigs.webpack, (err, stats) => {
                if (err) {
                    console.log(err);
                }
                resolve(stats);
            });
        }),
    );
    promises.push(esbuild.build(bundlerConfigs.esbuild));
    return Promise.all(promises);
};
