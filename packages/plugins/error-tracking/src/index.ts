// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPlugins } from '@dd/core/types';

import { PLUGIN_NAME } from './constants';
import { uploadSourcemaps } from './sourcemaps';
import type { ErrorTrackingOptions, ErrorTrackingOptionsWithSourcemaps } from './types';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME } from './constants';

export type types = {
    // Add the types you'd like to expose here.
    ErrorTrackingOptions: ErrorTrackingOptions;
};

export const getPlugins: GetPlugins = ({ options, context }) => {
    const log = context.getLogger(PLUGIN_NAME);
    // Verify configuration.
    const timeOptions = log.time('validate options');
    const validatedOptions = validateOptions(options, log);
    timeOptions.end();

    // If the plugin is not enabled, return an empty array.
    if (!validatedOptions.enable) {
        return [];
    }

    return [
        {
            name: PLUGIN_NAME,
            enforce: 'post',
            async writeBundle() {
                if (!validatedOptions.enable) {
                    return;
                }

                if (validatedOptions.sourcemaps) {
                    const totalTime = log.time('sourcemaps process');
                    // Need the "as" because Typescript doesn't understand that we've already checked for sourcemaps.
                    await uploadSourcemaps(
                        validatedOptions as ErrorTrackingOptionsWithSourcemaps,
                        context,
                        log,
                    );
                    totalTime.end();
                }
            },
        },
    ];
};
