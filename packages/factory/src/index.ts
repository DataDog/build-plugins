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
    Env,
    FactoryMeta,
    GetCustomPlugins,
    GetInternalPlugins,
    GetPlugins,
    GlobalContext,
    GlobalData,
    GlobalStores,
    Options,
    OptionsWithDefaults,
} from '@dd/core/types';
import type { UnpluginContextMeta, UnpluginInstance } from 'unplugin';
import { createUnplugin } from 'unplugin';
import chalk from 'chalk';

import { validateOptions } from './validate';
import { getContext } from './helpers/context';
import { wrapGetPlugins } from './helpers/wrapPlugins';
import { ALL_ENVS, HOST_NAME } from '@dd/core/constants';
import { notifyOnEnvOverrides } from '@dd/core/helpers/env';
// #imports-injection-marker
import * as errorTracking from '@dd/error-tracking-plugin';
import * as metrics from '@dd/metrics-plugin';
import * as output from '@dd/output-plugin';
import * as rum from '@dd/rum-plugin';
import { getAnalyticsPlugins } from '@dd/internal-analytics-plugin';
import { getAsyncQueuePlugins } from '@dd/internal-async-queue-plugin';
import { getBuildReportPlugins } from '@dd/internal-build-report-plugin';
import { getBundlerReportPlugins } from '@dd/internal-bundler-report-plugin';
import { getCustomHooksPlugins } from '@dd/internal-custom-hooks-plugin';
import { getGitPlugins } from '@dd/internal-git-plugin';
import { getInjectionPlugins } from '@dd/internal-injection-plugin';
import { getTrueEndPlugins } from '@dd/internal-true-end-plugin';
// #imports-injection-marker
// #types-export-injection-marker
export type { types as ErrorTrackingTypes } from '@dd/error-tracking-plugin';
export type { types as MetricsTypes } from '@dd/metrics-plugin';
export type { types as OutputTypes } from '@dd/output-plugin';
export type { types as RumTypes } from '@dd/rum-plugin';
// #types-export-injection-marker

export const helpers = {
    // Each product should have a unique entry.
    // #helpers-injection-marker
    [metrics.CONFIG_KEY]: metrics.helpers,
    // #helpers-injection-marker
};

const red = chalk.bold.red;

const blockOnDuplicateNames = (names: string[]) => {
    const duplicates = new Set(names.filter((name) => names.filter((n) => n === name).length > 1));
    if (duplicates.size > 0) {
        throw new Error(`Duplicate plugin names: ${red(Array.from(duplicates).join(', '))}`);
    }
};

export const buildPluginFactory = ({
    bundler,
    version,
}: FactoryMeta): UnpluginInstance<Options, true> => {
    const start = Date.now();
    return createUnplugin((opts: Options, unpluginMetaContext: UnpluginContextMeta) => {
        const pluginStart = Date.now();
        // TODO: Implement config overrides with environment variables.
        // TODO: Validate API Key and endpoint.
        // TODO: Inject a metric logger into the global context.

        const options: OptionsWithDefaults = validateOptions(opts);

        // Set the host name for the esbuild plugin.
        if (unpluginMetaContext.framework === 'esbuild') {
            unpluginMetaContext.esbuildHostName = HOST_NAME;
        }

        // Use "production" if there is no env passed.
        const passedEnv: Env = (process.env.BUILD_PLUGINS_ENV as Env) || 'production';
        // Fallback to "development" if the passed env is wrong.
        const env = ALL_ENVS.includes(passedEnv) ? passedEnv : 'development';
        // We need to account for how each bundler exposes its version.
        //   - (webpack|esbuild|vite).version
        //   - rollup.VERSION
        //   - rspack.rspackVersion
        const bundlerVersion = bundler.rspackVersion || bundler.version || bundler.VERSION;
        const bundlerName = unpluginMetaContext.framework as BundlerName;

        const data: GlobalData = {
            bundler: {
                name: bundlerName,
                version: bundlerVersion,
            },
            env,
            metadata: options.metadata || {},
            packageName: `@datadog/${bundlerName}-plugin`,
            version,
        };

        const stores: GlobalStores = {
            errors: [],
            logs: [],
            queue: [],
            timings: [],
            warnings: [],
        };

        // Create the global context.
        const context: GlobalContext = getContext({
            start,
            options,
            data,
            stores,
        });

        const log = context.getLogger('factory');
        const timeInit = log.time('Plugins initialization', { start: pluginStart });

        context.pluginNames.push(HOST_NAME);

        const pluginsToAdd: [name: string, GetPlugins | GetCustomPlugins | GetInternalPlugins][] =
            [];

        // List of plugins to be returned.
        // We keep the UnpluginOptions type for the custom plugins.
        pluginsToAdd.push(
            // Prefill with our internal plugins.
            // #internal-plugins-injection-marker
            ['analytics', getAnalyticsPlugins],
            ['async-queue', getAsyncQueuePlugins],
            ['build-report', getBuildReportPlugins],
            ['bundler-report', getBundlerReportPlugins],
            ['custom-hooks', getCustomHooksPlugins],
            ['git', getGitPlugins],
            ['injection', getInjectionPlugins],
            ['true-end', getTrueEndPlugins],
            // #internal-plugins-injection-marker
        );

        // Add custom, on the fly plugins, if any.
        if (options.customPlugins) {
            pluginsToAdd.push(['custom', options.customPlugins]);
        }

        // Add the customer facing plugins.
        pluginsToAdd.push(
            // #configs-injection-marker
            ['error-tracking', errorTracking.getPlugins],
            ['metrics', metrics.getPlugins],
            ['output', output.getPlugins],
            ['rum', rum.getPlugins],
            // #configs-injection-marker
        );

        // Initialize all our plugins.
        for (const [name, getPlugins] of pluginsToAdd) {
            context.plugins.push(
                ...wrapGetPlugins(
                    context,
                    getPlugins,
                    name,
                )({
                    bundler,
                    context,
                    options,
                    data,
                    stores,
                }),
            );
        }

        // Verify and notify about any overrides from the environment.
        notifyOnEnvOverrides(log);
        // List all our plugins in the context.
        context.pluginNames.push(...context.plugins.map((plugin) => plugin.name));
        // Verify we don't have plugins with the same name, as they would override each other.
        blockOnDuplicateNames(context.pluginNames);

        context.hook('init', context);
        timeInit.end();

        return context.plugins;
    });
};
