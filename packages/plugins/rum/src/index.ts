// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, GetPlugins, Logger } from '@dd/core/types';

import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import { getInjectionValue } from './sdk';
import type { OptionsWithRum, RumOptions } from './types';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME };

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
    log: Logger,
) => {
    // Verify configuration.
    const options = validateOptions(opts, log);

    if (options.sdk) {
        // Inject the SDK from the CDN.
        context.inject({
            type: 'file',
            value: 'https://www.datadoghq-browser-agent.com/us1/v5/datadog-rum.js',
        });

        context.inject({
            type: 'code',
            value: getInjectionValue(options.sdk, context),
        });
    }

    return [
        {
            name: PLUGIN_NAME,
        },
    ];
};
