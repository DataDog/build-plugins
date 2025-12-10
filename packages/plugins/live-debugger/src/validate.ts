// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, Options } from '@dd/core/types';
import chalk from 'chalk';

import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import type { LiveDebuggerOptions, LiveDebuggerOptionsWithDefaults } from './types';

const red = chalk.bold.red;

export const validateOptions = (config: Options, log: Logger): LiveDebuggerOptionsWithDefaults => {
    const pluginConfig: LiveDebuggerOptions = config[CONFIG_KEY] || {};
    const errors: string[] = [];

    // Validate include option
    if (pluginConfig.include !== undefined) {
        if (!Array.isArray(pluginConfig.include)) {
            errors.push(`${red('include')} must be an array of strings or RegExp`);
        } else {
            for (const pattern of pluginConfig.include) {
                if (typeof pattern !== 'string' && !(pattern instanceof RegExp)) {
                    errors.push(`${red('include')} patterns must be strings or RegExp`);
                    break;
                }
            }
        }
    }

    // Validate exclude option
    if (pluginConfig.exclude !== undefined) {
        if (!Array.isArray(pluginConfig.exclude)) {
            errors.push(`${red('exclude')} must be an array of strings or RegExp`);
        } else {
            for (const pattern of pluginConfig.exclude) {
                if (typeof pattern !== 'string' && !(pattern instanceof RegExp)) {
                    errors.push(`${red('exclude')} patterns must be strings or RegExp`);
                    break;
                }
            }
        }
    }

    // Validate skipHotFunctions option
    if (
        pluginConfig.skipHotFunctions !== undefined &&
        typeof pluginConfig.skipHotFunctions !== 'boolean'
    ) {
        errors.push(`${red('skipHotFunctions')} must be a boolean`);
    }

    // Throw if there are any errors
    if (errors.length) {
        log.error(`\n  - ${errors.join('\n  - ')}`);
        throw new Error(`Invalid configuration for ${PLUGIN_NAME}.`);
    }

    // Build the final configuration with defaults
    return {
        enable: !!pluginConfig.enable,
        include: pluginConfig.include || [/\.[jt]sx?$/], // .js, .jsx, .ts, .tsx
        exclude: pluginConfig.exclude || [
            /\/node_modules\//,
            /\.min\.js$/,
            /^vite\//, // Vite internal modules
            /\0/, // Virtual modules (Rollup/Vite convention)
            /commonjsHelpers\.js$/, // Rollup commonjs helpers
            /__vite-browser-external/, // Vite browser externals
            /@datadog\/browser-/, // Datadog browser SDK packages (when npm linked)
            /browser-sdk\/packages\//, // Datadog browser SDK source files
        ],
        skipHotFunctions: pluginConfig.skipHotFunctions ?? true,
    };
};
