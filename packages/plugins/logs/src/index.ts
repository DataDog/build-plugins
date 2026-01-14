// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPlugins, LogLevel } from '@dd/core/types';
import os from 'os';

import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import { getEsbuildPlugin } from './esbuild';
import { getRollupPlugin } from './rollup';
import { sendLogs } from './sender';
import type { DatadogLogEntry } from './types';
import { validateOptions } from './validate';
import { getXpackPlugin } from './xpack';

export { CONFIG_KEY, PLUGIN_NAME };

export const helpers = {
    // Add helpers to expose here.
};

export type types = {
    LogsOptions: import('./types').LogsOptions;
};

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    none: 4,
};

export const getPlugins: GetPlugins = ({ options, context, stores }) => {
    const log = context.getLogger(PLUGIN_NAME);
    const validatedOptions = validateOptions(options, log);

    if (!validatedOptions.enable) {
        return [];
    }

    const bundlerLogs: DatadogLogEntry[] = [];
    const hostname = os.hostname();
    const bundlerInfo = {
        name: context.bundler.name,
        version: context.bundler.version,
        outDir: context.bundler.outDir,
    };

    const createLogEntry = (
        message: string,
        status: 'debug' | 'info' | 'warn' | 'error',
        source: string,
        plugin?: string,
    ): DatadogLogEntry => ({
        message,
        status,
        ddsource: source,
        ddtags: validatedOptions.tags.join(','),
        service: validatedOptions.service,
        hostname,
        bundler: bundlerInfo,
        plugin,
        timestamp: Date.now(),
        ...(validatedOptions.env && { env: validatedOptions.env }),
    });

    return [
        {
            name: PLUGIN_NAME,
            enforce: 'post',
            esbuild: getEsbuildPlugin(validatedOptions, bundlerLogs, createLogEntry),
            rollup: getRollupPlugin(context, validatedOptions, bundlerLogs, createLogEntry),
            vite: getRollupPlugin(context, validatedOptions, bundlerLogs, createLogEntry),
            webpack: getXpackPlugin(
                context,
                PLUGIN_NAME,
                validatedOptions,
                bundlerLogs,
                createLogEntry,
            ),
            rspack: getXpackPlugin(
                context,
                PLUGIN_NAME,
                validatedOptions,
                bundlerLogs,
                createLogEntry,
            ),

            async buildReport() {
                // Collect internal plugin logs from stores
                if (validatedOptions.includePluginLogs) {
                    for (const internalLog of stores.logs) {
                        if (
                            LOG_LEVEL_PRIORITY[internalLog.type] >=
                            LOG_LEVEL_PRIORITY[validatedOptions.logLevel]
                        ) {
                            bundlerLogs.push(
                                createLogEntry(
                                    internalLog.message,
                                    internalLog.type as 'debug' | 'info' | 'warn' | 'error',
                                    'build-plugins',
                                    internalLog.pluginName,
                                ),
                            );
                        }
                    }
                }

                // Collect timing data if enabled
                if (validatedOptions.includeTimings) {
                    for (const timing of stores.timings) {
                        bundlerLogs.push({
                            ...createLogEntry(
                                `Timing: ${timing.label} - ${timing.total}ms`,
                                'info',
                                'build-plugins',
                                timing.pluginName,
                            ),
                            timing: { label: timing.label, total: timing.total },
                        });
                    }
                }

                // Collect build summary logs (timing, assets) if enabled.
                // We use the buildReport hook because BuildReport provides universal data
                // across all bundlers.
                if (validatedOptions.includeBundlerLogs) {
                    const { build } = context;

                    // Log build timing
                    if (build.duration !== undefined) {
                        bundlerLogs.push(
                            createLogEntry(
                                `Build completed in ${build.duration}ms`,
                                'info',
                                context.bundler.name,
                            ),
                        );
                    }

                    // Log asset summary
                    if (build.outputs && build.outputs.length > 0) {
                        const totalSize = build.outputs.reduce(
                            (sum, output) => sum + (output.size || 0),
                            0,
                        );
                        bundlerLogs.push(
                            createLogEntry(
                                `Generated ${build.outputs.length} assets (${(totalSize / 1024).toFixed(2)} KB total)`,
                                'info',
                                context.bundler.name,
                            ),
                        );
                    }
                }

                // Collect errors and warnings from the build report.
                // build.errors and build.warnings contain both bundler and internal errors,
                // each with an 'origin' field to distinguish them.
                const { build } = context;

                // Log errors (filtered by origin based on configuration)
                for (const error of build.errors) {
                    const shouldInclude =
                        (error.origin === 'bundler' && validatedOptions.includeBundlerLogs) ||
                        (error.origin === 'internal' && validatedOptions.includePluginLogs);
                    if (shouldInclude) {
                        bundlerLogs.push(
                            createLogEntry(error.message, 'error', context.bundler.name),
                        );
                    }
                }

                // Log warnings (filtered by origin based on configuration)
                for (const warning of build.warnings) {
                    const shouldInclude =
                        (warning.origin === 'bundler' && validatedOptions.includeBundlerLogs) ||
                        (warning.origin === 'internal' && validatedOptions.includePluginLogs);
                    if (shouldInclude) {
                        bundlerLogs.push(
                            createLogEntry(warning.message, 'warn', context.bundler.name),
                        );
                    }
                }

                // Filter by logLevel before sending
                const logsToSend = bundlerLogs.filter(
                    (entry) =>
                        LOG_LEVEL_PRIORITY[entry.status] >=
                        LOG_LEVEL_PRIORITY[validatedOptions.logLevel],
                );

                // Send all collected logs
                if (logsToSend.length > 0) {
                    const { errors, warnings } = await sendLogs(
                        logsToSend,
                        validatedOptions,
                        context.auth,
                        log,
                    );

                    for (const warning of warnings) {
                        log.warn(warning);
                    }
                    for (const error of errors) {
                        log.error(`Failed to send logs: ${error.message}`);
                    }

                    log.info(`Sent ${logsToSend.length} logs to Datadog`);
                }
            },
        },
    ];
};
