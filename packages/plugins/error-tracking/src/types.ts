// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPluginsOptions } from '@dd/core/types';

import type { CONFIG_KEY } from './constants';

export type MinifiedPathPrefix = `http://${string}` | `https://${string}` | `/${string}`;

export type SourcemapsOptions = {
    bailOnError?: boolean;
    disableGit?: boolean;
    dryRun?: boolean;
    intakeUrl?: string;
    maxConcurrency?: number;
    minifiedPathPrefix: MinifiedPathPrefix;
    releaseVersion: string;
    service: string;
};

export type SourcemapsOptionsWithDefaults = Required<SourcemapsOptions>;

export type ErrorTrackingOptions = {
    disabled?: boolean;
    sourcemaps?: SourcemapsOptions;
};

export type ErrorTrackingOptionsWithDefaults = {
    disabled?: boolean;
    sourcemaps?: SourcemapsOptionsWithDefaults;
};

export type ErrorTrackingOptionsWithSourcemaps = {
    disabled?: boolean;
    sourcemaps: SourcemapsOptionsWithDefaults;
};

export interface OptionsWithErrorTracking extends GetPluginsOptions {
    [CONFIG_KEY]: ErrorTrackingOptions;
}

export type Sourcemap = {
    minifiedFilePath: string;
    minifiedPathPrefix: MinifiedPathPrefix;
    minifiedUrl: string;
    relativePath: string;
    sourcemapFilePath: string;
};
