// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export type MinifiedPathPrefix = `http://${string}` | `https://${string}` | `/${string}`;

export type SourcemapsOptions = {
    bailOnError?: boolean;
    enableGit?: boolean;
    dryRun?: boolean;
    intakeUrl?: string;
    maxConcurrency?: number;
    minifiedPathPrefix: MinifiedPathPrefix;
    releaseVersion: string;
    service: string;
};

export type SourcemapsOptionsWithDefaults = Required<SourcemapsOptions>;

export type ErrorTrackingOptions = {
    enable?: boolean;
    sourcemaps?: SourcemapsOptions;
};

export type ErrorTrackingOptionsWithDefaults = {
    enable?: boolean;
    sourcemaps?: SourcemapsOptionsWithDefaults;
};

export type ErrorTrackingOptionsWithSourcemaps = {
    enable?: boolean;
    sourcemaps: SourcemapsOptionsWithDefaults;
};

export type Sourcemap = {
    minifiedFilePath: string;
    minifiedPathPrefix: MinifiedPathPrefix;
    minifiedUrl: string;
    relativePath: string;
    sourcemapFilePath: string;
};
