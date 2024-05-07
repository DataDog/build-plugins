// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { defaultTelemetryFilters } from '@datadog/build-plugins-core/helpers';
import type { Metric } from '@datadog/build-plugins-core/types';

import { CONFIG_KEY } from '../constants';
import type { OptionsWithTelemetryEnabled, OptionsDD, MetricToSend } from '../types';

export const getMetric = (metric: Metric, opts: OptionsDD): MetricToSend => ({
    type: 'gauge',
    tags: [...metric.tags, ...opts.tags],
    metric: `${opts.prefix ? `${opts.prefix}.` : ''}${metric.metric}`,
    points: [[opts.timestamp, metric.value]],
});

export const flattened = (arr: any[]) => [].concat(...arr);

export const getType = (name: string) => (name.includes('.') ? name.split('.').pop() : 'unknown');

export const getOptionsDD = (opt: OptionsWithTelemetryEnabled): OptionsDD => {
    const options = opt[CONFIG_KEY];
    return {
        timestamp: Math.floor((options.datadog?.timestamp || Date.now()) / 1000),
        apiKey: opt.auth.apiKey || '',
        tags: options.datadog?.tags || [],
        endPoint: options.datadog?.endPoint || 'app.datadoghq.com',
        prefix: options.datadog?.prefix || '',
        filters: options.datadog?.filters || defaultTelemetryFilters,
    };
};
