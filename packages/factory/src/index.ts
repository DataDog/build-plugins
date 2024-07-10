// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// This file is partially generated.
// Anything between #imports-injection-marker, #types-export-injection-marker, #helpers-injection-marker and #configs-injection-marker
// will be updated using the 'yarn cli integrity' command.

import { getInternalPlugins } from '@dd/core/plugins/index';
// eslint-disable-next-line arca/newline-after-import-section
import type { Options } from '@dd/core/types';

// #imports-injection-marker
import type { OptionsWithRum } from '@dd/rum-plugins/types';
import * as rum from '@dd/rum-plugins';
import type { OptionsWithTelemetry } from '@dd/telemetry-plugins/types';
import * as telemetry from '@dd/telemetry-plugins';
// #imports-injection-marker

import type { UnpluginContextMeta, UnpluginInstance, UnpluginOptions } from 'unplugin';
import { createUnplugin } from 'unplugin';

// #types-export-injection-marker
export type { types as RumTypes } from '@dd/rum-plugins';
export type { types as TelemetryTypes } from '@dd/telemetry-plugins';
// #types-export-injection-marker

export const helpers = {
    // Each product should have a unique entry.
    // #helpers-injection-marker
    [rum.CONFIG_KEY]: rum.helpers,
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
        // TODO: Validate API Key and endpoint.
        // TODO: Inject a metric logger into the global context.

        // Get the global context and internal plugins.
        const { globalContext, internalPlugins } = getInternalPlugins(options, {
            version,
            ...unpluginMetaContext,
        });

        // List of plugins to be returned.
        const plugins: UnpluginOptions[] = [...internalPlugins];

        // Based on configuration add corresponding plugin.
        // #configs-injection-marker
        if (options[rum.CONFIG_KEY] && options[rum.CONFIG_KEY].disabled !== true) {
            plugins.push(...rum.getPlugins(options as OptionsWithRum, globalContext));
        }
        if (options[telemetry.CONFIG_KEY] && options[telemetry.CONFIG_KEY].disabled !== true) {
            plugins.push(...telemetry.getPlugins(options as OptionsWithTelemetry, globalContext));
        }
        // #configs-injection-marker

        return plugins;
    });
};
