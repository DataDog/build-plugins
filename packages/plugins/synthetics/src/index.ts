// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, GetPlugins, Options } from '@dd/core/types';

import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import { getServerPlugin } from './helpers/server';
import type { SyntheticsOptions } from './types';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME };

export type types = {
    // Add the types you'd like to expose here.
    SyntheticsOptions: SyntheticsOptions;
};

export const getPlugins: GetPlugins = (opts: Options, context: GlobalContext) => {
    const log = context.getLogger(PLUGIN_NAME);
    // Verify configuration.
    const options = validateOptions(opts);

    if (options.disabled) {
        return [];
    }

    return [getServerPlugin(opts, options, log)];
};
