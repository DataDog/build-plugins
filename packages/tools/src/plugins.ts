// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BundlerName, Options } from '@dd/core/types';
import { CONFIG_KEY as ERROR_TRACKING } from '@dd/error-tracking-plugin';
import { CONFIG_KEY as RUM } from '@dd/rum-plugin';
import { CONFIG_KEY as TELEMETRY } from '@dd/telemetry-plugin';

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
    [RUM]: {
        sdk: {
            applicationId: '123',
            clientToken: '123',
        },
        privacy: {
            enable: true,
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

export const getWebpackPlugin = (config: Options) => {
    // eslint-disable-next-line import/no-unresolved
    const { datadogWebpackPlugin } = require('@datadog/webpack-plugin/dist/src/index.js');
    return datadogWebpackPlugin(config);
};

export const allPlugins: Record<BundlerName, (config: Options) => any> = {
    esbuild: getEsbuildPlugin,
    rollup: getRollupPlugin,
    rspack: getRspackPlugin,
    vite: getVitePlugin,
    webpack: getWebpackPlugin,
};
