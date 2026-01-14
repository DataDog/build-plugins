// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BundlerName, LogLevel } from '@dd/core/types';

export type BundlerInfo = {
    name: BundlerName;
    version: string;
    outDir: string;
};

export type LogsOptions = {
    enable?: boolean;
    service?: string;
    env?: string;
    tags?: string[];
    logLevel?: LogLevel;
    includeBundlerLogs?: boolean;
    includePluginLogs?: boolean;
    includeModuleEvents?: boolean;
    batchSize?: number;
    includeTimings?: boolean;
};

export type LogsOptionsWithDefaults = Required<Omit<LogsOptions, 'env'>> & {
    env?: string;
};

export type DatadogLogEntry = {
    message: string;
    status: 'debug' | 'info' | 'warn' | 'error';
    ddsource: string;
    ddtags: string;
    service: string;
    hostname: string;
    bundler: BundlerInfo;
    plugin?: string;
    timestamp: number;
    [key: string]: unknown;
};

export type CreateLogEntryFn = (
    message: string,
    status: 'debug' | 'info' | 'warn' | 'error',
    source: string,
    plugin?: string,
) => DatadogLogEntry;
