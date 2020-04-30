// Unless explicitly stated otherwise all files in this repository are licensed
// under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

const aggregator = require('./aggregator');
const c = require('chalk');
const { getMetric } = require('./helpers');
const sender = require('./sender');

const getOptionsDD = (opts = {}) => ({
    timestamp: Math.floor((opts.timestamp || Date.now()) / 1000),
    apiKey: opts.apiKey,
    tags: opts.tags || [],
    endPoint: opts.endPoint || 'app.datadoghq.com',
    prefix: opts.prefix || '',
    filters: opts.filters || [],
});

const preoutput = async function output({ report, stats }) {
    const optionsDD = getOptionsDD(this.options.datadog);

    let metrics = [];
    try {
        metrics = await aggregator.getMetrics(report, stats, {
            ...optionsDD,
            context: this.options.context,
        });
    } catch (e) {
        this.log(`Couldn't aggregate metrics. ${e.toString()}`, 'error');
    }

    return { metrics };
};

const postoutput = async function postoutput({ start, metrics }) {
    const PLUGIN_NAME = this.constructor.name;
    const duration = Date.now() - start;
    const optionsDD = getOptionsDD(this.options.datadog);
    // We're missing the duration of this hook for our plugin.
    metrics.push(
        getMetric(
            {
                tags: [`pluginName:${PLUGIN_NAME}`],
                metric: `plugins.meta.duration`,
                value: duration,
            },
            optionsDD
        )
    );

    this.log(`Took ${duration}ms.`);

    // Send everything only if we have the key.
    if (!optionsDD.apiKey) {
        this.log(`Won't send metrics to ${c.bold('Datadog')}: missing API Key.`, 'warn');
        return;
    }
    try {
        await sender.sendMetrics(metrics, {
            apiKey: optionsDD.apiKey,
            endPoint: optionsDD.endPoint,
        });
    } catch (e) {
        this.log(`Error sending metrics ${e.toString()}`, 'error');
    }

    return { metrics };
};

module.exports = {
    hooks: {
        preoutput,
        postoutput,
    },
};
