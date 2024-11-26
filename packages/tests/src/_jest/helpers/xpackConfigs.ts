// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getResolvedPath } from '@dd/core/helpers';
import type { Options } from '@dd/core/types';
import { buildPluginFactory } from '@dd/factory';
import type { RspackOptions } from '@rspack/core';
import path from 'path';
import type webpack4 from 'webpack4';
import type { Configuration as Configuration4 } from 'webpack4';
import type { Configuration as Configuration5 } from 'webpack5';
import type webpack5 from 'webpack5';

import { PLUGIN_VERSIONS } from './constants';
import { defaultDestination, defaultEntry } from './mocks';

export const getBaseXpackConfig = (
    seed: string,
    bundlerName: string,
): Configuration5 & Configuration4 & RspackOptions => {
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
                chunks: 'initial',
                minSize: 1,
                minChunks: 1,
                name: (...args: any[]) => {
                    // This is supposedly not available on rspack (based on types).
                    // But it is.
                    if (args[2]) {
                        return `chunk.${args[2]}`;
                    }

                    // This is never reached.
                    return `chunk.shouldNeverHappen`;
                },
            },
        },
    };
};

// Return the correct plugin for webpack 4 or 5.
export const getWebpackPlugin = (
    pluginOptions: Options,
    bundler: typeof webpack4 | typeof webpack5,
) => {
    // Need to use the factory directly since we pass the bundler to the factory.
    return buildPluginFactory({
        bundler,
        version: PLUGIN_VERSIONS.webpack,
    }).webpack(pluginOptions);
};

// Webpack 4 doesn't support pnp resolution OOTB.
export const getWebpack4Entries = (
    entries: NonNullable<Configuration5['entry']>,
    cwd: string = process.cwd(),
): Configuration4['entry'] => {
    const getTrueRelativePath = (filepath: string) => {
        return `./${path.relative(cwd, getResolvedPath(filepath))}`;
    };

    if (typeof entries === 'string') {
        return getTrueRelativePath(entries);
    }

    return Object.fromEntries(
        Object.entries(entries).map(([name, filepath]) => [
            name,
            Array.isArray(filepath)
                ? filepath.map(getTrueRelativePath)
                : getTrueRelativePath(filepath),
        ]),
    );
};
