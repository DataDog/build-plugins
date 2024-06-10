// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPluginsOptions, Report, Stats } from '@dd/core/types';
import type { BuildOptions, BuildResult, Metafile } from 'esbuild';

import type { CONFIG_KEY } from './constants';

export interface MetricToSend {
    type: 'gauge';
    tags: string[];
    metric: string;
    points: [number, number][];
}

export interface OptionsDD {
    tags: string[];
    prefix: string;
    timestamp: number;
    filters: Filter[];
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
    | string
    | {
          destination: string;
          timings?: boolean;
          dependencies?: boolean;
          bundler?: boolean;
          metrics?: boolean;
          logs?: boolean;
      };

export type TelemetryOptions = {
    disabled?: boolean;
    output?: OutputOptions;
    prefix?: string;
    tags?: string[];
    timestamp?: number;
    filters?: Filter[];
};

export interface OptionsWithTelemetry extends GetPluginsOptions {
    [CONFIG_KEY]: TelemetryOptions;
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
