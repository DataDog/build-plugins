// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable arca/import-ordering, arca/newline-after-import-section */
// This file is mostly generated.
// Anything between
//   - #imports-injection-marker
//   - #types-export-injection-marker
//   - #internal-plugins-injection-marker
//   - #helpers-injection-marker
//   - #configs-injection-marker
// will be updated using the 'yarn cli integrity' command.

import type {
    BundlerName,
    FactoryMeta,
    GlobalContext,
    Options,
    OptionsWithDefaults,
    PluginOptions,
    ToInjectItem,
} from '@dd/core/types';
import type { UnpluginContextMeta, UnpluginInstance, UnpluginOptions } from 'unplugin';
import { createUnplugin } from 'unplugin';
import chalk from 'chalk';

import { getContext, getLoggerFactory, validateOptions } from './helpers';

// #imports-injection-marker
import type { OptionsWithErrorTracking } from '@dd/error-tracking-plugin/types';
import * as errorTracking from '@dd/error-tracking-plugin';
import type { OptionsWithRum } from '@dd/rum-plugin/types';
import * as rum from '@dd/rum-plugin';
import type { OptionsWithTelemetry } from '@dd/telemetry-plugin/types';
import * as telemetry from '@dd/telemetry-plugin';
import { getBuildReportPlugins } from '@dd/internal-build-report-plugin';
import { getBundlerReportPlugins } from '@dd/internal-bundler-report-plugin';
import { getGitPlugins } from '@dd/internal-git-plugin';
import { getInjectionPlugins } from '@dd/internal-injection-plugin';
// #imports-injection-marker
// #types-export-injection-marker
export type { types as ErrorTrackingTypes } from '@dd/error-tracking-plugin';
export type { types as RumTypes } from '@dd/rum-plugin';
export type { types as TelemetryTypes } from '@dd/telemetry-plugin';
// #types-export-injection-marker

export const helpers = {
    // Each product should have a unique entry.
    // #helpers-injection-marker
    [telemetry.CONFIG_KEY]: telemetry.helpers,
    // #helpers-injection-marker
};

const HOST_NAME = 'datadog-build-plugins';

export const buildPluginFactory = ({
    bundler,
    version,
}: FactoryMeta): UnpluginInstance<Options, true> => {
    return createUnplugin((opts: Options, unpluginMetaContext: UnpluginContextMeta) => {
        // TODO: Implement config overrides with environment variables.
        // TODO: Validate API Key and endpoint.
        // TODO: Inject a metric logger into the global context.

        const options: OptionsWithDefaults = validateOptions(opts);

        // Set the host name for the esbuild plugin.
        if (unpluginMetaContext.framework === 'esbuild') {
            unpluginMetaContext.esbuildHostName = HOST_NAME;
        }

        // Create the global context.
        const injections: Map<string, ToInjectItem> = new Map();
        const context: GlobalContext = getContext({
            options,
            bundlerVersion: bundler.version || bundler.VERSION,
            bundlerName: unpluginMetaContext.framework as BundlerName,
            injections,
            version,
        });

        const getLogger = getLoggerFactory(context.build, options.logLevel);

        context.pluginNames.push(HOST_NAME);

        // List of plugins to be returned.
        // We keep the UnpluginOptions type for the custom plugins.
        const plugins: (PluginOptions | UnpluginOptions)[] = [
            // Prefill with our internal plugins.
            // #internal-plugins-injection-marker
            ...getBuildReportPlugins(context, getLogger('datadog-build-report-plugin')),
            ...getBundlerReportPlugins(context),
            ...getGitPlugins(options, context),
            ...getInjectionPlugins(
                bundler,
                options,
                context,
                injections,
                getLogger('datadog-injection-plugin'),
            ),
            // #internal-plugins-injection-marker
        ];

        // Add custom, on the fly plugins, if any.
        if (options.customPlugins) {
            const customPlugins = options.customPlugins(
                options,
                context,
                getLogger('datadog-custom-plugins'),
            );
            plugins.push(...customPlugins);
        }

        // Based on configuration add corresponding plugin.
        // #configs-injection-marker
        if (
            options[errorTracking.CONFIG_KEY] &&
            options[errorTracking.CONFIG_KEY].disabled !== true
        ) {
            plugins.push(
                ...errorTracking.getPlugins(
                    options as OptionsWithErrorTracking,
                    context,
                    getLogger(errorTracking.PLUGIN_NAME),
                ),
            );
        }
        if (options[rum.CONFIG_KEY] && options[rum.CONFIG_KEY].disabled !== true) {
            plugins.push(
                ...rum.getPlugins(options as OptionsWithRum, context, getLogger(rum.PLUGIN_NAME)),
            );
        }
        if (options[telemetry.CONFIG_KEY] && options[telemetry.CONFIG_KEY].disabled !== true) {
            plugins.push(
                ...telemetry.getPlugins(
                    options as OptionsWithTelemetry,
                    context,
                    getLogger(telemetry.PLUGIN_NAME),
                ),
            );
        }
        // #configs-injection-marker

        // List all our plugins in the context.
        context.pluginNames.push(...plugins.map((plugin) => plugin.name));

        // Verify we don't have plugins with the same name, as they would override each other.
        const duplicates = new Set(
            context.pluginNames.filter(
                (name) => context.pluginNames.filter((n) => n === name).length > 1,
            ),
        );
        if (duplicates.size > 0) {
            throw new Error(
                `Duplicate plugin names: ${chalk.bold.red(Array.from(duplicates).join(', '))}`,
            );
        }

        return plugins;
    });
};
