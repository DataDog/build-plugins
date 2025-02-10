// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';
import { buildPluginFactory } from '@dd/factory';
import type webpack4 from 'webpack4';
import type webpack5 from 'webpack5';

import { PLUGIN_VERSIONS } from './constants';

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
