// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPlugins, Options } from '@dd/core/types';

import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import type { CiVisibilityOptions, CiVisibilityOptionsWithDefaults } from './types';

export { CONFIG_KEY, PLUGIN_NAME };

export const helpers = {
    // Add the helpers you'd like to expose here.
};

export type types = {
    // Add the types you'd like to expose here.
    CiVisibilityOptions: CiVisibilityOptions;
};

// Deal with validation and defaults here.
export const validateOptions = (options: Options): CiVisibilityOptionsWithDefaults => {
    const validatedOptions: CiVisibilityOptionsWithDefaults = {
        disabled: !options[CONFIG_KEY],
        ...options[CONFIG_KEY],
    };
    return validatedOptions;
};

export const getPlugins: GetPlugins = ({ options, context }) => {
    // Verify configuration.
    const validatedOptions = validateOptions(options);

    // If the plugin is disabled, return an empty array.
    if (validatedOptions.disabled) {
        return [];
    }

    return [
        {
            name: PLUGIN_NAME,
        },
    ];
};
