// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getLogger } from '@dd/core/log';
import type { GlobalContext, GetPlugins } from '@dd/core/types';

import { PLUGIN_NAME } from './constants';
import { uploadSourcemaps } from './sourcemaps';
import type { OptionsWithRum, RumOptions, RumOptionsWithSourcemaps } from './types';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME } from './constants';

export const helpers = {
    // Add the helpers you'd like to expose here.
};

export type types = {
    // Add the types you'd like to expose here.
    RumOptions: RumOptions;
    OptionsWithRum: OptionsWithRum;
};

export const getPlugins: GetPlugins<OptionsWithRum> = (
    opts: OptionsWithRum,
    context: GlobalContext,
) => {
    // Verify configuration.
    const rumOptions = validateOptions(opts);
    return [
        {
            name: PLUGIN_NAME,
            async writeBundle() {
                if (rumOptions.disabled) {
                    return;
                }

                const log = getLogger(opts.logLevel, PLUGIN_NAME);
                if (rumOptions.sourcemaps) {
                    // Need the "as" because Typescript doesn't understand that we've already checked for sourcemaps.
                    await uploadSourcemaps(rumOptions as RumOptionsWithSourcemaps, context, log);
                }
            },
        },
    ];
};
