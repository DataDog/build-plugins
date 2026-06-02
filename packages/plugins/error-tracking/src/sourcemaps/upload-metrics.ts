// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers/request';
import type { Logger, Metric } from '@dd/core/types';

import type { SourcemapsOptionsWithDefaults } from '../types';

import type { UploadContext } from './sender';

export const SOURCEMAP_UPLOAD_METRIC_PREFIX = 'datadog.build_plugins.sourcemaps.upload';
const METRICS_API_PATH = 'api/v1/series';

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

const normalizeTagValue = (value: string): string =>
    value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_:./-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'unknown';

const getErrorTypeTag = (error: Error): string => {
    const statusCodeTag = getStatusCodeTag(error);
    if (statusCodeTag !== 'status_code:unknown') {
        return `error_type:http_${statusCodeTag.replace('status_code:', '')}`;
    }

    return `error_type:${normalizeTagValue(error.name || 'unknown')}`;
};

const getBaseMetricTags = (options: SourcemapsOptionsWithDefaults, context: UploadContext) => [
    `bundler:${context.bundlerName}`,
    `plugin_version:${context.version}`,
    `service:${options.service}`,
    `site:${context.site}`,
    ...(process.env.CI_JOB_NAME ? [`jobname:${normalizeTagValue(process.env.CI_JOB_NAME)}`] : []),
    ...(process.env.BRANCH_TYPE
        ? [`branchtype:${normalizeTagValue(process.env.BRANCH_TYPE)}`]
        : []),
];

export const createSourcemapUploadMetrics = (
    options: SourcemapsOptionsWithDefaults,
    context: UploadContext,
): SourcemapUploadMetrics => ({
    metrics: new Map(),
    baseTags: getBaseMetricTags(options, context),
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

const buildUploadMetricSeries = (uploadMetrics: SourcemapUploadMetrics): Metric[] => {
    const timestamp = Math.floor(Date.now() / 1000);
    return Array.from(uploadMetrics.metrics.values()).map((metric) => ({
        metric: `${SOURCEMAP_UPLOAD_METRIC_PREFIX}.${metric.name}`,
        type: 'count',
        points: [[timestamp, metric.value]],
        tags: metric.tags,
    }));
};

export const sendSourcemapUploadMetrics = async (
    uploadMetrics: SourcemapUploadMetrics,
    context: UploadContext,
    log: Logger,
) => {
    if (!context.sendMetrics) {
        return;
    }

    if (!uploadMetrics.metrics.size) {
        return;
    }

    if (!context.apiKey) {
        log.debug(`Won't send sourcemap upload metrics to Datadog: missing API Key.`);
        return;
    }

    const series = buildUploadMetricSeries(uploadMetrics);
    const url = `https://api.${context.site}/${METRICS_API_PATH}?api_key=${context.apiKey}`;
    try {
        await doRequest({
            method: 'POST',
            url,
            getData: () => ({
                data: JSON.stringify({ series }),
            }),
        });
    } catch (error) {
        log.debug(`Error sending sourcemap upload metrics: ${error}`);
    }
};
