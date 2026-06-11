// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { normalizeTagValue } from '@dd/core/helpers/strings';
import type { Metric } from '@dd/core/types';

import type { SourcemapsOptionsWithDefaults } from '../types';

import type { UploadContext } from './sender';

export const SOURCEMAP_UPLOAD_METRIC_PREFIX = 'sourcemaps.upload';

type UploadMetricName = 'retry' | 'failure';

type UploadMetric = {
    name: UploadMetricName;
    value: number;
    tags: string[];
};

export type SourcemapUploadMetrics = {
    metrics: Map<string, UploadMetric>;
    baseTags: string[];
};

const getMetricKey = (name: UploadMetricName, tags: string[]) => `${name}|${tags.join('|')}`;

const getStatusCodeTag = (error: Error): string => {
    const match = error.message.match(/HTTP (\d{3})/);
    return match ? `status_code:${match[1]}` : 'status_code:unknown';
};

const getErrorTypeTag = (error: Error): string => {
    const statusCodeTag = getStatusCodeTag(error);
    if (statusCodeTag !== 'status_code:unknown') {
        return `error_type:http_${statusCodeTag.replace('status_code:', '')}`;
    }

    return `error_type:${normalizeTagValue(error.name || 'unknown')}`;
};

export const createSourcemapUploadMetrics = (
    options: SourcemapsOptionsWithDefaults,
): SourcemapUploadMetrics => ({
    metrics: new Map(),
    baseTags: [`service:${options.service}`],
});

const incrementUploadMetric = (
    uploadMetrics: SourcemapUploadMetrics,
    name: UploadMetricName,
    tags: string[],
) => {
    const metricKey = getMetricKey(name, tags);
    const currentMetric = uploadMetrics.metrics.get(metricKey);
    if (currentMetric) {
        currentMetric.value++;
        return;
    }

    uploadMetrics.metrics.set(metricKey, { name, value: 1, tags });
};

export const recordSourcemapUploadRetry = (
    uploadMetrics: SourcemapUploadMetrics,
    error: Error,
    attempt: number,
) => {
    incrementUploadMetric(uploadMetrics, 'retry', [
        ...uploadMetrics.baseTags,
        `attempt:${attempt}`,
        getStatusCodeTag(error),
        getErrorTypeTag(error),
    ]);
};

export const recordSourcemapUploadFailure = (
    uploadMetrics: SourcemapUploadMetrics,
    error: Error,
) => {
    incrementUploadMetric(uploadMetrics, 'failure', [
        ...uploadMetrics.baseTags,
        getStatusCodeTag(error),
        getErrorTypeTag(error),
    ]);
};

export const getSourcemapUploadMetrics = (uploadMetrics: SourcemapUploadMetrics): Metric[] => {
    const timestamp = Math.floor(Date.now() / 1000);
    return Array.from(uploadMetrics.metrics.values()).map((metric) => ({
        metric: `${SOURCEMAP_UPLOAD_METRIC_PREFIX}.${metric.name}`,
        type: 'count',
        points: [[timestamp, metric.value]],
        tags: metric.tags,
    }));
};

export const addSourcemapUploadMetrics = (
    uploadMetrics: SourcemapUploadMetrics,
    context: UploadContext,
) => {
    if (!context.sendMetrics) {
        return;
    }

    if (!uploadMetrics.metrics.size) {
        return;
    }

    const metrics = getSourcemapUploadMetrics(uploadMetrics);
    for (const metric of metrics) {
        context.addMetric(metric);
    }
};
