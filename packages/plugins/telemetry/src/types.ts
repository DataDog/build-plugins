import type { GetPluginsOptions, Report, Stats } from '@datadog/build-plugins-core/types';
import type { BuildOptions, BuildResult, Metafile } from 'esbuild';

import type { CONFIG_KEY } from './constants';

export interface MetricToSend {
    type: 'gauge';
    tags: string[];
    metric: string;
    points: [number, number][];
}

export interface Options {
    apiKey: string;
    tags: string[];
    endPoint: string;
    prefix: string;
    timestamp: number;
    filters: Filter[];
}

export interface GetMetricsOptions extends Options {
    context: string;
}

export interface Metric {
    metric: string;
    type: 'count' | 'size' | 'duration';
    value: number;
    tags: string[];
}

export type Filter = (metric: Metric) => Metric | null;

export interface DatadogOptions {
    apiKey?: string;
    endPoint?: string;
    prefix?: string;
    tags?: string[];
    timestamp?: number;
    filters?: Filter[];
}

export type OutputOptions =
    | boolean
    | string
    | {
          destination: string;
          timings?: boolean;
          dependencies?: boolean;
          bundler?: boolean;
          metrics?: boolean;
      };

export type TelemetryOptions = {
    disabled?: boolean;
    output?: OutputOptions;
    hooks?: string[];
    datadog?: DatadogOptions;
    context?: string;
};

export interface OptionsWithTelemetry extends GetPluginsOptions {
    [CONFIG_KEY]: TelemetryOptions;
}

export interface OptionsWithTelemetryEnabled extends GetPluginsOptions {
    [CONFIG_KEY]: TelemetryOptions & { disabled: false | undefined };
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
