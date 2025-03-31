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
    GetInternalPluginsArg,
    GlobalContext,
    Options,
    OptionsWithDefaults,
} from '@dd/core/types';
import type { UnpluginContextMeta, UnpluginInstance } from 'unplugin';
import { createUnplugin } from 'unplugin';
import chalk from 'chalk';

import { validateOptions } from './validate';
import { getContext } from './helpers/context';
import { HOST_NAME } from '@dd/core/constants';
// #imports-injection-marker
import * as errorTracking from '@dd/error-tracking-plugin';
import * as rum from '@dd/rum-plugin';
import * as telemetry from '@dd/telemetry-plugin';
import { getAnalyticsPlugins } from '@dd/internal-analytics-plugin';
import { getBuildReportPlugins } from '@dd/internal-build-report-plugin';
import { getBundlerReportPlugins } from '@dd/internal-bundler-report-plugin';
import { getCustomHooksPlugins } from '@dd/internal-custom-hooks-plugin';
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
        const context: GlobalContext = getContext({
            options,
            bundlerVersion: bundler.version || bundler.VERSION,
            bundlerName: unpluginMetaContext.framework as BundlerName,
            version,
        });

        context.pluginNames.push(HOST_NAME);

        const getInternalPluginsArg: GetInternalPluginsArg = {
            bundler,
            context,
            options,
        };

        // List of plugins to be returned.
        // We keep the UnpluginOptions type for the custom plugins.
        context.plugins.push(
            // Prefill with our internal plugins.
            // #internal-plugins-injection-marker
            ...getAnalyticsPlugins(getInternalPluginsArg),
            ...getBuildReportPlugins(getInternalPluginsArg),
            ...getBundlerReportPlugins(getInternalPluginsArg),
            ...getCustomHooksPlugins(getInternalPluginsArg),
            ...getGitPlugins(getInternalPluginsArg),
            ...getInjectionPlugins(getInternalPluginsArg),
            // #internal-plugins-injection-marker
        );

        // Add custom, on the fly plugins, if any.
        if (options.customPlugins) {
            const customPlugins = options.customPlugins(options, context);
            context.plugins.push(...customPlugins);
        }

        // Add the customer facing plugins.
        const productPlugins = [
            // #configs-injection-marker
            errorTracking,
            rum,
            telemetry,
            // #configs-injection-marker
        ];

        for (const plugin of productPlugins) {
            context.plugins.push(...plugin.getPlugins(options, context));
        }

        // List all our plugins in the context.
        context.pluginNames.push(...context.plugins.map((plugin) => plugin.name));

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

        context.hook('init', context);

        return context.plugins;
    });
};
