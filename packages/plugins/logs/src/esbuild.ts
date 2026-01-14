// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginOptions } from '@dd/core/types';

import type { CreateLogEntryFn, DatadogLogEntry, LogsOptionsWithDefaults } from './types';

export const getEsbuildPlugin = (
    options: LogsOptionsWithDefaults,
    collectedLogs: DatadogLogEntry[],
    createLogEntry: CreateLogEntryFn,
): PluginOptions['esbuild'] => {
    return {
        setup(build) {
            // NOTE: Errors and warnings are collected via the buildReport hook in index.ts,
            // using build.errors/warnings which are populated by the build-report plugin.
            if (options.includeModuleEvents) {
                build.onResolve({ filter: /.*/ }, (args) => {
                    collectedLogs.push(
                        createLogEntry(
                            `Resolving: ${args.path} from ${args.importer || 'entry'}`,
                            'debug',
                            'esbuild',
                        ),
                    );
                    return undefined;
                });
                build.onLoad({ filter: /.*/ }, (args) => {
                    collectedLogs.push(createLogEntry(`Loading: ${args.path}`, 'debug', 'esbuild'));
                    return undefined;
                });
            }
        },
    };
};
