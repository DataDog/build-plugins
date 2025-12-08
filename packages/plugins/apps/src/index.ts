// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPlugins, Options } from '@dd/core/types';

import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import type { AppsOptions, AppsOptionsWithDefaults } from './types';

export { CONFIG_KEY, PLUGIN_NAME };

export type types = {
    // Add the types you'd like to expose here.
    AppsOptions: AppsOptions;
};

// Deal with validation and defaults here.
export const validateOptions = (options: Options): AppsOptionsWithDefaults => {
    const validatedOptions: AppsOptionsWithDefaults = {
        // By using an empty object, we consider the plugin as enabled.
        enable: !!options[CONFIG_KEY],
        ...options[CONFIG_KEY],
    };
    return validatedOptions;
};

export const getPlugins: GetPlugins = ({ options, context }) => {
    // Verify configuration.
    const validatedOptions = validateOptions(options);

    // If the plugin is not enabled, return an empty array.
    if (!validatedOptions.enable) {
        return [];
    }

    // const log = context.getLogger(PLUGIN_NAME);

    return [
        {
            name: PLUGIN_NAME,
            // Enforce when the plugin will be executed.
            // Not supported by Rollup and ESBuild.
            // https://vitejs.dev/guide/api-plugin.html#plugin-ordering
            enforce: 'pre',
            async buildEnd() {
                // Execute code after the build ends.
                // https://rollupjs.org/plugin-development/#buildend
            },
        },
    ];
};
