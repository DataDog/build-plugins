// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPluginsOptions, GetPluginsOptionsWithCWD } from '@dd/core/types';
// #imports-injection-marker
// #imports-injection-marker
import type { UnpluginContextMeta, UnpluginInstance, UnpluginOptions } from 'unplugin';
import { createUnplugin } from 'unplugin';

export interface Options extends GetPluginsOptions {
    // Each product should have a unique entry.
    // #types-injection-marker
    // #types-injection-marker
}

// This remains internal as we inject the cwd part only from here.
interface OptionsWithCWD extends Options, GetPluginsOptionsWithCWD {}

export const helpers = {
    // Each product should have a unique entry.
    // #helpers-injection-marker
    // #helpers-injection-marker
};

export const buildPluginFactory = (): UnpluginInstance<Options, true> => {
    return createUnplugin((userOptions: Options, unpluginMetaContext: UnpluginContextMeta) => {
        // TODO: Implement config overrides with environment variables.
        const options: OptionsWithCWD = {
            cwd: process.cwd(),
            ...userOptions,
        };

        const plugins: UnpluginOptions[] = [];

        // Based on configuration add corresponding plugin.
        // #configs-injection-placeholder
        // #configs-injection-placeholder

        return plugins;
    });
};
