// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, PluginOptions } from '@dd/core/types';

import type { CreateLogEntryFn, DatadogLogEntry, LogsOptionsWithDefaults } from './types';

export const getRollupPlugin = (
    context: GlobalContext,
    options: LogsOptionsWithDefaults,
    collectedLogs: DatadogLogEntry[],
    createLogEntry: CreateLogEntryFn,
): PluginOptions['rollup'] => {
    return {
        // Collect rollup's internal logging (info, debug messages).
        // NOTE: Errors and warnings are collected via the buildReport hook in index.ts,
        // using build.errors/warnings which are populated by the build-report plugin.
        onLog(level, logItem) {
            if (!options.includeBundlerLogs) {
                return;
            }
            const message = logItem.message || logItem.toString();
            const status = level === 'warn' ? 'warn' : level === 'info' ? 'info' : 'debug';
            collectedLogs.push(createLogEntry(message, status, context.bundler.name));
        },
        moduleParsed(info) {
            if (!options.includeModuleEvents) {
                return;
            }
            collectedLogs.push(
                createLogEntry(`Module parsed: ${info.id}`, 'debug', context.bundler.name),
            );
        },
    };
};
