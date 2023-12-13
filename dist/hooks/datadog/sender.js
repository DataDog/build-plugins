"use strict";
// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
Object.defineProperty(exports, "__esModule", { value: true });
const https_1 = require("https");
exports.sendMetrics = (metrics, opts) => {
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
        const req = https_1.request({
            method: 'POST',
            hostname: opts.endPoint,
            path: `/api/v1/series?api_key=${opts.apiKey}`,
        });
        req.write(JSON.stringify({
            series: metrics,
        }));
        req.on('response', (res) => {
            if (!(res.statusCode >= 200 && res.statusCode < 300)) {
                // Untyped method https://nodejs.org/api/http.html#http_http_get_url_options_callback
                // Consume response data to free up memory
                // @ts-ignore
                res.resume();
                reject(`Request Failed.\nStatus Code: ${res.statusCode}`);
                return;
            }
            // Empty event required, otherwise the 'end' event is never emitted
            res.on('data', () => { });
            res.on('end', resolve);
        });
        req.on('error', reject);
        req.end();
    });
};
