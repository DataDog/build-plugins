// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, GetPlugins, Logger } from '@dd/core/types';

import { PLUGIN_NAME } from './constants';
import { uploadSourcemaps } from './sourcemaps';
import type {
    OptionsWithErrorTracking,
    ErrorTrackingOptions,
    ErrorTrackingOptionsWithSourcemaps,
} from './types';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME } from './constants';

export type types = {
    // Add the types you'd like to expose here.
    ErrorTrackingOptions: ErrorTrackingOptions;
    OptionsWithErrorTracking: OptionsWithErrorTracking;
};

export const getPlugins: GetPlugins<OptionsWithErrorTracking> = (
    opts: OptionsWithErrorTracking,
    context: GlobalContext,
    log: Logger,
) => {
    // Verify configuration.
    const options = validateOptions(opts, log);
    return [
        {
            name: PLUGIN_NAME,
            enforce: 'post',
            async writeBundle() {
                if (options.disabled) {
                    return;
                }

                if (options.sourcemaps) {
                    // Need the "as" because Typescript doesn't understand that we've already checked for sourcemaps.
                    await uploadSourcemaps(
                        options as ErrorTrackingOptionsWithSourcemaps,
                        context,
                        log,
                    );
                }
            },
        },
    ];
};
