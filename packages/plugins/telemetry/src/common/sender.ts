// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest, formatDuration } from '@dd/core/helpers';
import type { Logger } from '@dd/core/types';
import type { MetricToSend } from '@dd/telemetry-plugin/types';

export const sendMetrics = (
    metrics: Set<MetricToSend>,
    auth: { apiKey?: string; endPoint: string },
    log: Logger,
) => {
    const startSending = Date.now();
    if (!auth.apiKey) {
        log.warn(`Won't send metrics to Datadog: missing API Key.`);
        return;
    }
    if (!metrics.size) {
        log.warn(`No metrics to send.`);
        return;
    }

    const metricIterations: Map<string, number> = new Map();
    for (const metric of metrics) {
        if (!metricIterations.has(metric.metric)) {
            metricIterations.set(metric.metric, 0);
        }
        metricIterations.set(metric.metric, metricIterations.get(metric.metric)! + 1);
    }

    const metricsNames = Array.from(metricIterations.entries()).map(
        ([name, count]) => `${name} - ${count}`,
    );

    log.debug(`
Sending ${metrics.size} metrics.
Metrics:
    - ${metricsNames.join('\n    - ')}`);

    return doRequest({
        method: 'POST',
        url: `${auth.endPoint}/api/v1/series?api_key=${auth.apiKey}`,
        getData: () => ({ data: JSON.stringify({ series: metrics }) }),
    })
        .then(() => {
            log.debug(`Sent metrics in ${formatDuration(Date.now() - startSending)}.`);
        })
        .catch((e) => {
            log.error(`Error sending metrics ${e}`);
        });
};
