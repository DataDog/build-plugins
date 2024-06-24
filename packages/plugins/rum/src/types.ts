// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPluginsOptions } from '@dd/core/types';

import type { CONFIG_KEY } from './constants';

export type MinifiedPathPrefix = `http://${string}` | `/${string}`;

export type RumSourcemapsOptions = {
    // TODO: Compute this basePath directly from the bundler's configuration, using the CrossHelper Plugin.
    basePath: string;
    dryRun?: boolean;
    intakeUrl?: string;
    maxConcurrency?: number;
    minifiedPathPrefix: MinifiedPathPrefix;
    releaseVersion: string;
    service: string;
};

export type RumOptions = {
    disabled?: boolean;
    sourcemaps?: RumSourcemapsOptions;
};

export type RumSourcemapsOptionsWithDefaults = Required<RumSourcemapsOptions>;

export type RumOptionsWithDefaults = {
    disabled?: boolean;
    sourcemaps?: RumSourcemapsOptionsWithDefaults;
};

export type RumOptionsWithSourcemaps = {
    disabled?: boolean;
    sourcemaps: RumSourcemapsOptionsWithDefaults;
};

export interface OptionsWithRum extends GetPluginsOptions {
    [CONFIG_KEY]: RumOptions;
}

export type Sourcemap = {
    minifiedFilePath: string;
    minifiedPathPrefix: MinifiedPathPrefix;
    minifiedUrl: string;
    relativePath: string;
    sourcemapFilePath: string;
};
