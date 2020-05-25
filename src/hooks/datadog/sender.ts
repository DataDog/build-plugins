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
    apiKey?: string;
    appKey?: string;
    token?: string;
    agentPath?: string;
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
        let requestOpts;
        let payload;
        const rand = Math.floor(Math.random() * 100000000000);
        const traces = [
            {
                SpanId: rand,
                TraceId: rand,
                Service: 'build-plugin',
                Name: 'span_name',
                Resource: '/home',
                Start: Math.floor(Date.now() * 1000),
                Duration: 5,
                Meta: {
                    env: 'yoann-test',
                    'span.kind': 'client',
                    'http.method': 'GET',
                    'http.url': 'http://localhost',
                    'navigator.browser.name': 'Chrome',
                    'navigator.browser.version': '80.0.3987.122',
                    'navigator.os.name': 'macOS',
                    'navigator.os.version': '10.13.6',
                    'navigator.os.versionName': 'High Sierra',
                    'navigator.platform.type': 'desktop',
                    'navigator.platform.vendor': 'Apple',
                    'navigator.engine.name': 'Blink',
                },
                Metrics: {
                    _sample_rate: 1,
                    _top_level: 1,
                    'http.status': 200,
                    '_dd.agent_psr': 1,
                    _sampling_priority_v1: 1,
                },
            },
        ];

        if (opts.agentPath && opts.appKey) {
            // Agent intake.
            requestOpts = {
                method: 'PUT',
                hostname: opts.agentPath,
                headers: {
                    'Content-Type': 'application/json',
                    'DD-API-KEY': opts.apiKey,
                    'DD-APPLICATION-KEY': opts.appKey,
                },
                path: `/api/v0.3/traces`,
            };

            payload = [traces];
        } else {
            // AgentLess intake
            requestOpts = {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain;charset=UTF-8',
                },
                hostname: `public-trace-http-intake.logs.datadoghq.com`,
                path: `/v1/input/${opts.token}`,
            };

            payload = {
                Spans: [traces],
                Env: 'yoann-test',
            };
        }

        console.log(rand, requestOpts);

        const req = request(requestOpts);
        req.write(JSON.stringify(payload));

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
