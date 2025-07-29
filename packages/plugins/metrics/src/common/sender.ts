// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers/request';
import type { Logger } from '@dd/core/types';
import type { MetricToSend } from '@dd/metrics-plugin/types';

export const sendMetrics = (
    metrics: Set<MetricToSend>,
    auth: { apiKey?: string; endPoint: string },
    log: Logger,
) => {
    if (!auth.apiKey) {
        log.info(`Won't send metrics to Datadog: missing API Key.`);
        return;
    }
    if (!metrics.size) {
        log.info(`No metrics to send.`);
        return;
    }

    const metricIterations: Map<string, number> = new Map();
    for (const metric of metrics) {
        if (!metricIterations.has(metric.metric)) {
            metricIterations.set(metric.metric, 0);
        }
        metricIterations.set(metric.metric, metricIterations.get(metric.metric)! + 1);
    }

    const metricsNames = Array.from(metricIterations.entries())
        // Sort by metric name.
        .sort(([nameA], [nameB]) => nameA.localeCompare(nameB))
        .map(([name, count]) => `${name} - ${count}`);

    log.debug(`
Sending ${metrics.size} metrics.
Metrics:
    - ${metricsNames.join('\n    - ')}`);

    return doRequest({
        method: 'POST',
        url: `${auth.endPoint}/api/v1/series?api_key=${auth.apiKey}`,
        getData: () => ({
            data: JSON.stringify({ series: Array.from(metrics) } satisfies {
                series: MetricToSend[];
            }),
        }),
    }).catch((e) => {
        log.error(`Error sending metrics ${e}`);
    });
};
