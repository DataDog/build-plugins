const aggregator = require('./aggregator');
const c = require('chalk');
const { getMetric } = require('build-plugin/hooks/datadog/helpers');
const sender = require('./sender');

const preoutput = async function output({ report, stats }) {
    const PLUGIN_NAME = this.constructor.name;

    let metrics = [];
    try {
        metrics = await aggregator.getMetrics(report, stats, this.options);
    } catch (e) {
        this.log(`Couldn't aggregate metrics. ${e.toString()}`, 'error');
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

    this.log(`Took ${duration}ms.`);

    // Send everything only if we have the key.
        this.log(
            `Won't send metrics to ${c.bold('Datadog')}: missing API Key.`,
            'warn'
        );
        return;
    }
    try {
        await sender.sendMetrics(metrics, {
            apiKey: this.options.apiKey,
            endPoint: this.options.endPoint
        });
    } catch (e) {
        this.log(`Error sending metrics ${e.toString()}`, 'error');
    }

    return { metrics };
};

module.exports = {
    hooks: {
        preoutput,
        postoutput
    }
};
