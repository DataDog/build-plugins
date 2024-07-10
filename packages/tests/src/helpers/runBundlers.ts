// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';
import type { BuildOptions } from 'esbuild';
import esbuild from 'esbuild';
import { rmSync } from 'fs';
import type { Configuration as Configuration4 } from 'webpack4';
import webpack4 from 'webpack4';
import type { Configuration } from 'webpack';
import webpack from 'webpack';

import { getEsbuildOptions, getWebpack4Options, getWebpackOptions } from './configBundlers';
import { defaultDestination } from './mocks';

export const runWebpack = async (
    pluginOptions: Options = {},
    bundlerOptions: Partial<Configuration> = {},
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

export const runWebpack4 = async (
    pluginOptions: Options = {},
    bundlerOptions: Partial<Configuration4> = {},
) => {
    const bundlerConfigs = getWebpack4Options(pluginOptions, bundlerOptions);
    return new Promise((resolve) => {
        webpack4(bundlerConfigs, (err, stats) => {
            if (err) {
                console.log(err);
            }
            resolve(stats);
        });
    });
};

export const runEsbuild = async (
    pluginOptions: Options = {},
    bundlerOptions: Partial<BuildOptions> = {},
) => {
    const bundlerConfigs = getEsbuildOptions(pluginOptions, bundlerOptions);
    return esbuild.build(bundlerConfigs);
};

export const runBundlers = async (pluginOptions: Options = {}) => {
    const promises = [];

    rmSync(defaultDestination, { recursive: true, force: true });

    promises.push(runWebpack(pluginOptions));
    promises.push(runWebpack4(pluginOptions));
    promises.push(runEsbuild(pluginOptions));

    const results = await Promise.all(promises);

    return results;
};
