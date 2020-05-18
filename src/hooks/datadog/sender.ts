// Unless explicitly stated otherwise all files in this repository are licensed
// under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { request } from 'https';
import { ServerResponse } from 'http';

import { MetricToSend } from './types';

interface SenderMetricsOptions {
    apiKey: string;
    endPoint: string;
}

interface SenderTraceOptions {
    apiKey: string;
    appKey: string;
    endPoint: string;
}

export const sendMetrics = (metrics: MetricToSend[], opts: SenderMetricsOptions) => {
    if (!metrics || !metrics.length) {
        throw new Error('No metrics to send.');
    }

    const metricsNames = [...new Set(metrics.map((m) => m.metric))]
        .sort()
        .map((name) => `${name} - ${metrics.filter((m) => m.metric === name).length}`);

    // eslint-disable-next-line no-console
    console.log(`
Sending ${metrics.length} metrics.
Metrics:
    - ${metricsNames.join('\n    - ')}`);

    return new Promise((resolve, reject) => {
        const req = request({
            method: 'POST',
            hostname: opts.endPoint,
            path: `/api/v1/series?api_key=${opts.apiKey}`,
        });

        req.write(
            JSON.stringify({
                series: metrics,
            })
        );

        req.on('response', (res: ServerResponse) => {
            if (!(res.statusCode >= 200 && res.statusCode < 300)) {
                // Untyped method https://nodejs.org/api/http.html#http_http_get_url_options_callback
                // Consume response data to free up memory
                // @ts-ignore
                res.resume();
                reject(`Request Failed.\nStatus Code: ${res.statusCode}`);
                return;
            }
            // Empty event required, otherwise the 'end' event is never emitted
            res.on('data', () => {});
            res.on('end', resolve);
        });

        req.on('error', reject);
        req.end();
    });
};

export const sendTrace = (opts: SenderTraceOptions) => {
    return new Promise((resolve, reject) => {
        const req = request({
            method: 'PUT',
            hostname: 'http://localhost:8126',
            headers: {
                'Content-Type': 'application/json',
                'DD-API-KEY': opts.apiKey,
                'DD-APPLICATION-KEY': opts.appKey,
            },
            path: `/api/v0.3/traces`,
        });

        req.write(
            JSON.stringify([
                [
                    {
                        duration: null,
                        name: 'span_name',
                        resource: '/home',
                        service: 'service_name',
                        span_id: '987654321',
                        start: null,
                        trace_id: '123456789',
                    },
                ],
            ])
        );

        req.on('response', (res: ServerResponse) => {
            if (!(res.statusCode >= 200 && res.statusCode < 300)) {
                // Untyped method https://nodejs.org/api/http.html#http_http_get_url_options_callback
                // Consume response data to free up memory
                // @ts-ignore
                res.resume();
                reject(`Request Failed.\nStatus Code: ${res.statusCode}`);
                return;
            }
            // Empty event required, otherwise the 'end' event is never emitted
            res.on('data', () => {});
            res.on('end', resolve);
        });

        req.on('error', reject);
        req.end();
    });
};
