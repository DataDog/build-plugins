// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { CONFIG_KEY } from '../constants';
import type {
    OptionsDD,
    Metric,
    MetricToSend,
    TelemetryOptions,
    OptionsWithTelemetry,
} from '../types';

import { defaultFilters } from './filters';

export const getMetric = (metric: Metric, opts: OptionsDD): MetricToSend => ({
    type: 'gauge',
    tags: [...metric.tags, ...opts.tags],
    metric: `${opts.prefix ? `${opts.prefix}.` : ''}${metric.metric}`,
    points: [[opts.timestamp, metric.value]],
});

export const flattened = (arr: any[]) => [].concat(...arr);

export const getType = (name: string) => (name.includes('.') ? name.split('.').pop() : 'unknown');

export const getOptionsDD = (options: TelemetryOptions): OptionsDD => {
    return {
        timestamp: Math.floor((options.timestamp || Date.now()) / 1000),
        tags: options.tags || [],
        prefix: options.prefix || '',
        filters: options.filters || defaultFilters,
    };
};

export const validateOptions = (options: OptionsWithTelemetry): TelemetryOptions => {
    const validatedOptions: TelemetryOptions = options[CONFIG_KEY] || { disabled: false };
    return validatedOptions;
};
