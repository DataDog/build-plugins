// Unless explicitly stated otherwise all files in this repository are licensed
// under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { HooksContext } from '../../types';

export interface MetricToSend {
    type: 'gauge';
    tags: string[];
    metric: string;
    points: [number, number][];
}

export interface Metric {
    metric: string;
    type: 'count' | 'size' | 'duration';
    value: number;
    tags: string[];
}

export type Filter = (metric: Metric) => Metric | null;

export interface OptionsInput {
    apiKey: string;
    tags?: string[];
    endPoint?: string;
    prefix?: string;
    timestamp?: number;
    filters?: Filter[];
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

export interface DDHooksContext extends HooksContext {
    metrics: MetricToSend[];
}
