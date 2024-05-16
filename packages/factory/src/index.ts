// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPluginsOptions, GetPluginsOptionsWithCWD } from '@dd/core/types';
import type { OptionsWithTelemetryEnabled, TelemetryOptions } from '@dd/telemetry-plugins/types';
import {
    helpers as telemetryHelpers,
    getPlugins as getTelemetryPlugins,
    CONFIG_KEY as TELEMETRY_CONFIG_KEY,
} from '@dd/telemetry-plugins';
/* #imports-injection-placeholder  */
import type { UnpluginContextMeta, UnpluginInstance, UnpluginOptions } from 'unplugin';
import { createUnplugin } from 'unplugin';

export interface Options extends GetPluginsOptions {
    // Each product should have a unique entry.
    [TELEMETRY_CONFIG_KEY]?: TelemetryOptions;
    /* #types-injection-placeholder  */
}

// This remains internal as we inject the cwd part only from here.
interface OptionsWithCWD extends Options, GetPluginsOptionsWithCWD {}

export const helpers = {
    // Each product should have a unique entry.
    [TELEMETRY_CONFIG_KEY]: telemetryHelpers,
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
        if (options[TELEMETRY_CONFIG_KEY] && options[TELEMETRY_CONFIG_KEY].disabled !== true) {
            plugins.push(...getTelemetryPlugins(options as OptionsWithTelemetryEnabled));
        }
        /* #configs-injection-placeholder  */

        return plugins;
    });
};
