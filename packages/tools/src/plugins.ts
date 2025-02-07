// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BundlerFullName, Options } from '@dd/core/types';
import { CONFIG_KEY as ERROR_TRACKING } from '@dd/error-tracking-plugin';
import { CONFIG_KEY as TELEMETRY } from '@dd/telemetry-plugin';
import fs from 'fs';
import path from 'path';

import { ROOT } from './constants';

export const defaultConfig: Options = {
    auth: {
        apiKey: process.env.DATADOG_API_KEY,
        appKey: process.env.DATADOG_APP_KEY,
    },
};

export const fullConfig: Options = {
    ...defaultConfig,
    [ERROR_TRACKING]: {
        sourcemaps: {
            bailOnError: false,
            dryRun: false,
            maxConcurrency: 10,
            minifiedPathPrefix: '/',
            releaseVersion: '1.0.0',
            service: 'error-tracking-build-plugin-sourcemaps',
        },
    },
    [TELEMETRY]: {
        enableTracing: true,
        timestamp: new Date().getTime(),
    },
};

// We load the plugins dynamically to avoid esm/cjs issues.
// Using '*/dist/src' to specifically target the bundled files.

export const getEsbuildPlugin = (config: Options) => {
    // eslint-disable-next-line import/no-unresolved
    const { datadogEsbuildPlugin } = require('@datadog/esbuild-plugin/dist/src');
    return datadogEsbuildPlugin(config);
};

export const getRollupPlugin = (config: Options) => {
    // eslint-disable-next-line import/no-unresolved
    const { datadogRollupPlugin } = require('@datadog/rollup-plugin/dist/src');
    return datadogRollupPlugin(config);
};

export const getRspackPlugin = (config: Options) => {
    // eslint-disable-next-line import/no-unresolved
    const { datadogRspackPlugin } = require('@datadog/rspack-plugin/dist/src');
    return datadogRspackPlugin(config);
};

export const getVitePlugin = (config: Options) => {
    // eslint-disable-next-line import/no-unresolved
    const { datadogVitePlugin } = require('@datadog/vite-plugin/dist/src');
    return datadogVitePlugin(config);
};

export const getWebpack4Plugin = (config: Options) => {
    // We'll write a plugin specifically for Webpack4.
    const webpackPluginRoot = path.resolve(ROOT, 'packages/published/webpack-plugin/dist/src');
    const webpack4PluginPath = path.resolve(webpackPluginRoot, 'index4.js');
    const webpack5PluginPath = path.resolve(webpackPluginRoot, 'index.js');

    // First verify if it exists already or not.
    if (!fs.existsSync(webpack4PluginPath)) {
        // Create the file with the correct imports of Webpack4.
        fs.writeFileSync(
            webpack4PluginPath,
            fs
                .readFileSync(webpack5PluginPath, { encoding: 'utf-8' })
                .replace(/require\(('|")webpack("|')\)/g, "require('webpack4')"),
        );
    }

    // eslint-disable-next-line import/no-unresolved
    const { datadogWebpackPlugin } = require('@datadog/webpack-plugin/dist/src/index4.js');
    return datadogWebpackPlugin(config);
};

export const getWebpack5Plugin = (config: Options) => {
    // eslint-disable-next-line import/no-unresolved
    const { datadogWebpackPlugin } = require('@datadog/webpack-plugin/dist/src/index.js');
    return datadogWebpackPlugin(config);
};

export const allPlugins: Record<BundlerFullName, (config: Options) => any> = {
    esbuild: getEsbuildPlugin,
    rollup: getRollupPlugin,
    rspack: getRspackPlugin,
    vite: getVitePlugin,
    webpack4: getWebpack4Plugin,
    webpack5: getWebpack5Plugin,
};
