// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { type GlobalContext, type GetPlugins, type Logger, InjectPosition } from '@dd/core/types';
import path from 'path';

import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import { getInjectionValue } from './sdk';
import type { OptionsWithRum, RumOptions, RumOptionsWithSdk } from './types';
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

    // NOTE: These files are built from "@dd/tools/rollupConfig.mjs" and available in the distributed package.
    if (options.sdk) {
        // Inject the SDK from the CDN.
        context.inject({
            type: 'file',
            // It's MIDDLE otherwise it's not executed before the rum react plugin injection.
            position: InjectPosition.MIDDLE,
            // This file is being built alongside the bundler plugin.
            value: path.join(__dirname, './rum-browser-sdk.js'),
        });

        if (options.react) {
            // Inject the rum-react-plugin.
            context.inject({
                type: 'file',
                // It's MIDDLE in order to be able to import "react", "react-dom" and "react-router-dom".
                // If put in BEFORE, it would not have access to the dependencies of the user's project.
                position: InjectPosition.MIDDLE,
                // This file is being built alongside the bundler plugin.
                value: path.join(__dirname, './rum-react-plugin.js'),
            });
        }

        // Inject the SDK Initialization.
        context.inject({
            type: 'code',
            position: InjectPosition.MIDDLE,
            value: getInjectionValue(options as RumOptionsWithSdk, context),
        });
    }

    return [
        {
            name: PLUGIN_NAME,
        },
    ];
};
