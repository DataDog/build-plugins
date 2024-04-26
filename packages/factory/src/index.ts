import type {
    GetPluginsOptions,
    GetPluginsOptionsWithCWD,
} from '@datadog/build-plugins-core/types';
import type { OptionsWithTelemetryEnabled, TelemetryOptions } from '@dd/telemetry-plugins/types';
import {
    getPlugins as getTelemetryPlugins,
    CONFIG_KEY as TELEMETRY_CONFIG_KEY,
} from '@dd/telemetry-plugins';
import type { UnpluginContextMeta, UnpluginInstance, UnpluginOptions } from 'unplugin';
import { createUnplugin } from 'unplugin';

export interface Options extends GetPluginsOptions {
    // Each product should have a unique entry.
    [TELEMETRY_CONFIG_KEY]?: TelemetryOptions;
}

// This remains internal as we inject the cwd part only from here.
interface OptionsWithCWD extends Options, GetPluginsOptionsWithCWD {}

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

        return plugins;
    });
};
