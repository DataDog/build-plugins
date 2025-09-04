// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, Options } from '@dd/core/types';
import chalk from 'chalk';

import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import type {
    ErrorTrackingOptions,
    ErrorTrackingOptionsWithDefaults,
    SourcemapsOptionsWithDefaults,
} from './types';

// Deal with validation and defaults here.
export const validateOptions = (config: Options, log: Logger): ErrorTrackingOptionsWithDefaults => {
    const errors: string[] = [];

    // Validate and add defaults sub-options.
    const sourcemapsResults = validateSourcemapsOptions(config);
    errors.push(...sourcemapsResults.errors);

    // Throw if there are any errors.
    if (errors.length) {
        log.error(`\n  - ${errors.join('\n  - ')}`);
        throw new Error(`Invalid configuration for ${PLUGIN_NAME}.`);
    }

    // Build the final configuration.
    const toReturn: ErrorTrackingOptionsWithDefaults = {
        enable: !!config[CONFIG_KEY],
        ...config[CONFIG_KEY],
        sourcemaps: undefined,
    };

    // Fill in the defaults.
    if (sourcemapsResults.config) {
        toReturn.sourcemaps = sourcemapsResults.config;
    }

    return toReturn;
};

type ToReturn<T> = {
    errors: string[];
    config?: T;
};

const validateMinifiedPathPrefix = (minifiedPathPrefix: string): boolean => {
    let host;
    try {
        const objUrl = new URL(minifiedPathPrefix!);
        host = objUrl.host;
    } catch {
        // Do nothing.
    }

    if (!host && !minifiedPathPrefix!.startsWith('/')) {
        return false;
    }

    return true;
};

export const validateSourcemapsOptions = (
    config: Options,
): ToReturn<SourcemapsOptionsWithDefaults> => {
    const red = chalk.bold.red;
    const validatedOptions: ErrorTrackingOptions = config[CONFIG_KEY] || {};
    const toReturn: ToReturn<SourcemapsOptionsWithDefaults> = {
        errors: [],
    };

    if (validatedOptions.sourcemaps) {
        // Validate the configuration.
        if (!validatedOptions.sourcemaps.releaseVersion) {
            toReturn.errors.push(`${red('sourcemaps.releaseVersion')} is required.`);
        }
        if (!validatedOptions.sourcemaps.service) {
            toReturn.errors.push(`${red('sourcemaps.service')} is required.`);
        }
        if (!validatedOptions.sourcemaps.minifiedPathPrefix) {
            toReturn.errors.push(`${red('sourcemaps.minifiedPathPrefix')} is required.`);
        }

        // Validate the minifiedPathPrefix.
        if (validatedOptions.sourcemaps.minifiedPathPrefix) {
            if (!validateMinifiedPathPrefix(validatedOptions.sourcemaps.minifiedPathPrefix)) {
                toReturn.errors.push(
                    `${red('sourcemaps.minifiedPathPrefix')} must be a valid URL or start with '/'.`,
                );
            }
        }

        // Add the defaults.
        const sourcemapsWithDefaults: SourcemapsOptionsWithDefaults = {
            bailOnError: false,
            dryRun: false,
            maxConcurrency: 20,
            ...validatedOptions.sourcemaps,
        };

        // Save the config.
        toReturn.config = sourcemapsWithDefaults;
    }

    return toReturn;
};
