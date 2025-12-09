// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export type AppsOptions = {
    enable?: boolean;
    include?: string[];
    dryRun?: boolean;
};

export type AppsOptionsWithDefaults = Required<Omit<AppsOptions, 'include'>> & {
    include: string[];
};
