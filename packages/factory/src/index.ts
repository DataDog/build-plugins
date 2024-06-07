// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/*
You should probably not touch this file.
It's mostly filled automatically with new plugins.
*/

import { getCrossHelpersPlugin } from '@dd/core/plugins';
import type { GetPluginsOptions } from '@dd/core/types';
// #imports-injection-marker
import type { TelemetryOptions } from '@dd/telemetry-plugins/types';
import * as telemetry from '@dd/telemetry-plugins';
// #imports-injection-marker
import type { UnpluginContextMeta, UnpluginInstance, UnpluginOptions } from 'unplugin';
import { createUnplugin } from 'unplugin';

// #types-export-injection-marker
export type { types as TelemetryTypes } from '@dd/telemetry-plugins';
// #types-export-injection-marker

export interface Options extends GetPluginsOptions {
    // Each product should have a unique entry.
    // #types-injection-marker
    [telemetry.CONFIG_KEY]?: TelemetryOptions;
    // #types-injection-marker
}

interface DefinedOptions extends Required<Options> {}

export const helpers = {
    // Each product should have a unique entry.
    // #helpers-injection-marker
    [telemetry.CONFIG_KEY]: telemetry.helpers,
    // #helpers-injection-marker
};

export const buildPluginFactory = ({
    version,
}: {
    version: string;
}): UnpluginInstance<Options, true> => {
    return createUnplugin((options: Options, unpluginMetaContext: UnpluginContextMeta) => {
        // TODO: Implement config overrides with environment variables.

        // List of plugins to be returned.
        const { context, plugin: crossHelpersPlugin } = getCrossHelpersPlugin({
            version,
            ...unpluginMetaContext,
        });
        const plugins: UnpluginOptions[] = [
            // Having the cross-helpers plugin first is important.
            crossHelpersPlugin,
        ];

        // Based on configuration add corresponding plugin.
        // #configs-injection-marker
        if (options[telemetry.CONFIG_KEY] && options[telemetry.CONFIG_KEY].disabled !== true) {
            options[telemetry.CONFIG_KEY] = telemetry.validateOptions(options as DefinedOptions);
            plugins.push(...telemetry.getPlugins(options as DefinedOptions, context));
        }
        // #configs-injection-marker

        return plugins;
    });
};
