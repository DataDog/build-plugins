// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, OptionsWithDefaults } from '@dd/core/types';
import chalk from 'chalk';

import {
    CONFIG_KEY,
    DEFAULT_BATCH_SIZE,
    DEFAULT_LOG_LEVEL,
    DEFAULT_SERVICE,
    PLUGIN_NAME,
} from './constants';
import type { LogsOptions, LogsOptionsWithDefaults } from './types';

export const validateOptions = (
    options: OptionsWithDefaults,
    log: Logger,
): LogsOptionsWithDefaults => {
    const red = chalk.bold.red;
    const logsOptions: LogsOptions | undefined = options[CONFIG_KEY];

    // If logs config is not present, return disabled
    if (!logsOptions) {
        return {
            enable: false,
            service: DEFAULT_SERVICE,
            tags: [],
            logLevel: DEFAULT_LOG_LEVEL,
            includeBundlerLogs: true,
            includePluginLogs: true,
            includeModuleEvents: false,
            batchSize: DEFAULT_BATCH_SIZE,
            includeTimings: false,
        };
    }

    // If explicitly disabled, return early
    if (logsOptions.enable === false) {
        return {
            enable: false,
            service: DEFAULT_SERVICE,
            tags: [],
            logLevel: DEFAULT_LOG_LEVEL,
            includeBundlerLogs: true,
            includePluginLogs: true,
            includeModuleEvents: false,
            batchSize: DEFAULT_BATCH_SIZE,
            includeTimings: false,
        };
    }

    const errors: string[] = [];

    // Validate API key is available
    if (!options.auth.apiKey) {
        errors.push(`Missing ${red('"auth.apiKey"')} required for sending logs to Datadog.`);
    }

    // Throw if there are any errors
    if (errors.length) {
        log.error(`\n  - ${errors.join('\n  - ')}`);
        throw new Error(`Invalid configuration for ${PLUGIN_NAME}.`);
    }

    // Build the final configuration with defaults
    const validatedOptions: LogsOptionsWithDefaults = {
        enable: true,
        service: logsOptions.service ?? DEFAULT_SERVICE,
        tags: logsOptions.tags ?? [],
        logLevel: logsOptions.logLevel ?? DEFAULT_LOG_LEVEL,
        includeBundlerLogs: logsOptions.includeBundlerLogs ?? true,
        includePluginLogs: logsOptions.includePluginLogs ?? true,
        includeModuleEvents: logsOptions.includeModuleEvents ?? false,
        batchSize: logsOptions.batchSize ?? DEFAULT_BATCH_SIZE,
        includeTimings: logsOptions.includeTimings ?? false,
        ...(logsOptions.env && { env: logsOptions.env }),
    };

    log.debug(`datadog-logs-plugin options: ${JSON.stringify(validatedOptions)}`, {
        forward: true,
    });

    return validatedOptions;
};
