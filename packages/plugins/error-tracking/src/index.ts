// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPlugins } from '@dd/core/types';

import { PLUGIN_NAME } from './constants';
import type { OptionsWithErrorTrackingEnabled, ErrorTrackingOptions } from './types';

export { CONFIG_KEY, PLUGIN_NAME } from './constants';

export const helpers = {
    // Add the helpers you'd like to expose here.
};

export type types = {
    // Add the types you'd like to expose here.
    ErrorTrackingOptions: ErrorTrackingOptions;
    OptionsWithErrorTrackingEnabled: OptionsWithErrorTrackingEnabled;
};

export const getPlugins: GetPlugins<OptionsWithErrorTrackingEnabled> = (
    opt: OptionsWithErrorTrackingEnabled,
) => {
    return [
        {
            name: PLUGIN_NAME,
        },
    ];
};
