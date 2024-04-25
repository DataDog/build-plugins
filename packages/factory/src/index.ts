import type { GetPluginsOptions } from '@datadog/build-plugins-core/types';
import type { OptionsWithTelemetryEnabled, TelemetryOptions } from '@dd/telemetry-plugins/types';
import {
    getPlugins as getTelemetryPlugins,
    CONFIG_KEY as TELEMETRY_CONFIG_KEY,
} from '@dd/telemetry-plugins';
import type { UnpluginContextMeta, UnpluginOptions } from 'unplugin';
import { createUnplugin } from 'unplugin';

export interface Options extends GetPluginsOptions {
    // Each product should have a unique entry.
    [TELEMETRY_CONFIG_KEY]: TelemetryOptions;
}

export const buildPluginFactory = () => {
    return createUnplugin((userOptions: Options, unpluginMetaContext: UnpluginContextMeta) => {
        // Parse/Read/Use user configuration.
        // Implement config overrides with environment variables.
        if (userOptions) {
            console.log('Got options', userOptions);
        }

        const plugins: UnpluginOptions[] = [];

        // Based on configuration add corresponding plugin.
        if (
            userOptions[TELEMETRY_CONFIG_KEY] &&
            userOptions[TELEMETRY_CONFIG_KEY].disabled !== true
        ) {
            plugins.push(...getTelemetryPlugins(userOptions as OptionsWithTelemetryEnabled));
        }

        return plugins;
    });
};
