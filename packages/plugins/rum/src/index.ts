// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginOptions, GetPlugins } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import path from 'path';

import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import { getInjectionValue } from './sdk';
import type { RumOptions, RumOptionsWithSdk, RumPublicApi, RumInitConfiguration } from './types';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME };

export const helpers = {
    // Add the helpers you'd like to expose here.
};

export type types = {
    // Add the types you'd like to expose here.
    RumOptions: RumOptions;
    RumPublicApi: RumPublicApi;
    RumInitConfiguration: RumInitConfiguration;
};

export const getPlugins: GetPlugins = ({ options, context }) => {
    const log = context.getLogger(PLUGIN_NAME);
    // Verify configuration.
    const validatedOptions = validateOptions(options, log);
    const plugins: PluginOptions[] = [];

    // If the plugin is disabled, return an empty array.
    if (validatedOptions.disabled) {
        return plugins;
    }

    // NOTE: These files are built from "@dd/tools/rollupConfig.mjs" and available in the distributed package.
    if (validatedOptions.sdk) {
        // Inject the SDK from the CDN.
        context.inject({
            type: 'file',
            // Using MIDDLE otherwise it's not executed in context.
            position: InjectPosition.MIDDLE,
            // This file is being built alongside the bundler plugin.
            value: path.join(__dirname, './rum-browser-sdk.js'),
        });

        // Inject the SDK Initialization.
        context.inject({
            type: 'code',
            position: InjectPosition.MIDDLE,
            value: getInjectionValue(validatedOptions as RumOptionsWithSdk, context),
        });
    }

    return plugins;
};
