/* eslint-disable no-console */
const aggregator = require('./aggregator');
const { getMetric } = require('build-plugin/hooks/datadog/helpers');
const sender = require('./sender');

const preoutput = async function output({ report, stats }) {
    const PLUGIN_NAME = this.constructor.name;

    let metrics = [];
    try {
        metrics = await aggregator.getMetrics(report, stats, this.options);
    } catch (e) {
        console.error(`[${PLUGIN_NAME}] Couldn't aggregate metrics.`, e);
    }

    return { metrics };
};

const postoutput = async function postoutput({ start, metrics }) {
    const PLUGIN_NAME = this.constructor.name;
    const duration = Date.now() - start;
    // We're missing the duration of this hook for our plugin.
    metrics.push(
        getMetric(
            {
                tags: [`pluginName:${PLUGIN_NAME}`],
                metric: `plugins.meta.duration`,
                value: duration
            },
            this.options
        )
    );

    console.log(`[${PLUGIN_NAME}] Took ${duration}ms.`);

    // Send everything only if we have the key.
    if (!this.options.apiKey) {
        console.warn(`[${PLUGIN_NAME}] Won't send metrics: missing API Key.`);
        return;
    }
    try {
        await sender.sendMetrics(metrics, {
            apiKey: this.options.apiKey,
            endPoint: this.options.endPoint
        });
    } catch (e) {
        console.error(`[${PLUGIN_NAME}] Error sending metrics`, e);
    }

    return { metrics };
};

module.exports = {
    hooks: {
        preoutput,
        postoutput
    }
};
