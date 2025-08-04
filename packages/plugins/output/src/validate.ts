// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';

import { CONFIG_KEY } from './constants';
import type { FileKey, OutputOptions, OutputOptionsWithDefaults } from './types';

// Sanitize the output path.
const sanitizeOutputPath = (key: FileKey, value: boolean | string) => {
    if (typeof value === 'string') {
        // Ensure we end with the correct extension.
        return value.replace(/\.json$/, '.json');
    }

    // Transform the value into a path.
    return value === true ? `./${key}.json` : value;
};

const validateFilesOptions = (
    files: OutputOptions['files'],
): OutputOptionsWithDefaults['files'] => {
    // If no files object is provided, we'll output all files.
    const defaultValue = typeof files === 'undefined';

    const validatedFiles: OutputOptionsWithDefaults['files'] = {
        // Listing everything to keep TS happy.
        build: sanitizeOutputPath('build', files?.build ?? defaultValue),
        bundler: sanitizeOutputPath('bundler', files?.bundler ?? defaultValue),
        dependencies: sanitizeOutputPath('dependencies', files?.dependencies ?? defaultValue),
        errors: sanitizeOutputPath('errors', files?.errors ?? defaultValue),
        logs: sanitizeOutputPath('logs', files?.logs ?? defaultValue),
        metrics: sanitizeOutputPath('metrics', files?.metrics ?? defaultValue),
        timings: sanitizeOutputPath('timings', files?.timings ?? defaultValue),
        warnings: sanitizeOutputPath('warnings', files?.warnings ?? defaultValue),
    };

    return validatedFiles;
};

// Deal with validation and defaults here.
export const validateOptions = (options: Options): OutputOptionsWithDefaults => {
    const validatedOptions: OutputOptionsWithDefaults = {
        // By using an empty object, we consider the plugin as enabled.
        enable: !!options[CONFIG_KEY],
        path: './',
        ...options[CONFIG_KEY],
        files: validateFilesOptions(options[CONFIG_KEY]?.files),
    };

    return validatedOptions;
};
