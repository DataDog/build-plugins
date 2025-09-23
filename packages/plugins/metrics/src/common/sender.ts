// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers/request';
import type { Logger, Metric, MetricToSend } from '@dd/core/types';
import chalk from 'chalk';

export const METRICS_API_PATH = 'api/v1/series';

const green = chalk.bold.green;

export const sendMetrics = (
    metrics: Set<MetricToSend>,
    auth: { apiKey?: string; site: string },
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

    // Only send metrics that are to be sent.
    const metricsToSend: Metric[] = Array.from(metrics)
        .filter((metric) => metric.toSend)
        .map((metric) => {
            return {
                ...metric,
                toSend: undefined,
            };
        });

    const metricIterations: Map<string, number> = new Map();
    for (const metric of metricsToSend) {
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
Sending ${metricsToSend.length} metrics with configuration:
  - intake: ${green(`https://api.${auth.site}/${METRICS_API_PATH}`)}

Metrics:
    - ${metricsNames.join('\n    - ')}`);

    return doRequest({
        method: 'POST',
        url: `https://api.${auth.site}/${METRICS_API_PATH}?api_key=${auth.apiKey}`,
        getData: () => ({
            data: JSON.stringify({ series: metricsToSend } satisfies {
                series: Metric[];
            }),
        }),
    }).catch((e) => {
        log.error(`Error sending metrics ${e}`);
    });
};
