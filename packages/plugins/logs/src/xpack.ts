// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, IterableElement, PluginOptions } from '@dd/core/types';

import type { CreateLogEntryFn, DatadogLogEntry, LogsOptionsWithDefaults } from './types';

export const getXpackPlugin = (
    context: GlobalContext,
    pluginName: string,
    options: LogsOptionsWithDefaults,
    collectedLogs: DatadogLogEntry[],
    createLogEntry: CreateLogEntryFn,
): PluginOptions['webpack'] & PluginOptions['rspack'] => {
    return (compiler) => {
        // Types for the xpack hooks.
        type Compilation = Parameters<Parameters<typeof compiler.hooks.thisCompilation.tap>[1]>[0];
        type Module = IterableElement<Compilation['modules']>;
        type Stats = Parameters<Parameters<typeof compiler.hooks.done.tap>[1]>[0];

        compiler.hooks.thisCompilation.tap(pluginName, (compilation: Compilation) => {
            if (options.includeModuleEvents) {
                compilation.hooks.buildModule.tap(pluginName, (module: Module) => {
                    const id = module.identifier?.() || 'unknown';
                    collectedLogs.push(
                        createLogEntry(`Building module: ${id}`, 'debug', context.bundler.name),
                    );
                });
                compilation.hooks.succeedModule.tap(pluginName, (module: Module) => {
                    const id = module.identifier?.() || 'unknown';
                    collectedLogs.push(
                        createLogEntry(`Module built: ${id}`, 'debug', context.bundler.name),
                    );
                });
            }
        });

        // Extract webpack's built-in logging entries.
        // NOTE: Errors and warnings are collected via the buildReport hook in index.ts,
        // using build.errors/warnings which are populated by the build-report plugin.
        compiler.hooks.done.tap(pluginName, (stats: Stats) => {
            if (!options.includeBundlerLogs) {
                return;
            }

            const statsJson = stats.toJson({
                logging: true,
                loggingTrace: false,
            });

            // Log any logging entries from webpack's built-in logging
            if (statsJson.logging) {
                for (const [loggerName, logEntries] of Object.entries(statsJson.logging)) {
                    const entries =
                        (logEntries as { entries?: Array<{ type: string; message: string }> })
                            .entries || [];
                    for (const entry of entries) {
                        const status =
                            entry.type === 'error'
                                ? 'error'
                                : entry.type === 'warn'
                                  ? 'warn'
                                  : entry.type === 'info'
                                    ? 'info'
                                    : 'debug';
                        collectedLogs.push(
                            createLogEntry(
                                `[${loggerName}] ${entry.message}`,
                                status,
                                context.bundler.name,
                            ),
                        );
                    }
                }
            }
        });
    };
};
