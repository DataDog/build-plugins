// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPluginsOptionsWithCWD, Report, Stats } from '@dd/core/types';
import type { BuildOptions, BuildResult, Metafile } from 'esbuild';

import type { CONFIG_KEY } from './constants';

export type LogLevel = 'debug' | 'warn' | 'error' | 'none';

export interface MetricToSend {
    type: 'gauge';
    tags: string[];
    metric: string;
    points: [number, number][];
}

export interface OptionsDD {
    apiKey: string;
    tags: string[];
    endPoint: string;
    prefix: string;
    timestamp: number;
    filters: Filter[];
    logLevel: LogLevel;
}

export interface Metric {
    metric: string;
    type: 'count' | 'size' | 'duration';
    value: number;
    tags: string[];
}

export type Filter = (metric: Metric) => Metric | null;

export type OutputOptions =
    | boolean
    | LogLevel
    | string
    | {
          destination: string;
          timings?: boolean;
          dependencies?: boolean;
          bundler?: boolean;
          metrics?: boolean;
          level?: LogLevel;
      };

export type TelemetryOptions = {
    disabled?: boolean;
    output?: OutputOptions;
    endPoint?: string;
    prefix?: string;
    tags?: string[];
    timestamp?: number;
    filters?: Filter[];
};

export interface TelemetryOptionsEnabled extends TelemetryOptions {
    disabled?: false;
}

export interface OptionsWithTelemetryEnabled extends GetPluginsOptionsWithCWD {
    [CONFIG_KEY]: TelemetryOptionsEnabled;
}

interface EsbuildBundlerResult extends Metafile {
    warnings: BuildResult['warnings'];
    errors: BuildResult['errors'];
    entrypoints: BuildOptions['entryPoints'];
    duration: number;
}

export type Context = {
    start: number;
    report: Report;
    metrics?: MetricToSend[];
    bundler: {
        esbuild?: EsbuildBundlerResult;
        webpack?: Stats;
    };
};
