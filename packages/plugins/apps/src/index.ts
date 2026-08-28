// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPlugins } from '@dd/core/types';

import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import type { AppsOptions } from './types';
import { validateOptions } from './validate';
import { getVitePlugin } from './vite/index';

export { CONFIG_KEY, PLUGIN_NAME };

export type types = {
    // Add the types you'd like to expose here.
    AppsOptions: AppsOptions;
};

export const getPlugins: GetPlugins = ({ options, context, bundler }) => {
    const log = context.getLogger(PLUGIN_NAME);
    const validatedOptions = validateOptions(options);

    if (context.bundler.name !== 'vite') {
        log.warn(`The apps plugin only supports Vite; skipping under '${context.bundler.name}'.`);
        return [];
    }

    // Vite's production hook creates the deployable package; publishing is
    // intentionally owned by @datadog/apps-cli. Backend functions are compiled
    // before packaging inside closeBundle.
    return [
        {
            name: PLUGIN_NAME,
            enforce: 'post',
            vite: getVitePlugin({
                bundler,
                context,
                options: validatedOptions,
            }),
        },
    ];
};
