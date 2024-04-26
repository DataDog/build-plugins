import { formatDuration } from '@datadog/build-plugins-core/helpers';
import c from 'chalk';

import { PLUGIN_NAME } from '../../constants';
import type { Context, OptionsWithTelemetryEnabled } from '../../types';
import { getMetrics } from '../aggregator';
import { getMetric, getOptionsDD } from '../helpers';
import { sendMetrics } from '../sender';

export const addMetrics = (context: Context, options: OptionsWithTelemetryEnabled) => {
    const { report, bundler } = context;

    context.metrics = context.metrics || [];
    try {
        context.metrics = getMetrics(options, report, bundler);
    } catch (e) {
        const stack = e instanceof Error ? e.stack : e;
        console.log(`Couldn't aggregate metrics: ${stack}`, 'error');
    }
};

export const processMetrics = async (context: Context, options: OptionsWithTelemetryEnabled) => {
    const { start } = context;
    const duration = Date.now() - start;
    const optionsDD = getOptionsDD(options);
    context.metrics = context.metrics || [];
    // We're missing the duration of this hook for our plugin.
    context.metrics.push(
        getMetric(
            {
                tags: [`pluginName:${PLUGIN_NAME}`],
                metric: `plugins.meta.duration`,
                type: 'duration',
                value: duration,
            },
            optionsDD,
        ),
    );

    console.log(`Took ${formatDuration(duration)}.`);

    // Send everything only if we have the key.
    if (!optionsDD.apiKey) {
        console.log(`Won't send metrics to ${c.bold('Datadog')}: missing API Key.`, 'warn');
        return;
    }
    try {
        const startSending = Date.now();
        await sendMetrics(context.metrics, {
            apiKey: optionsDD.apiKey,
            endPoint: optionsDD.endPoint,
        });
        console.log(`Sent metrics in ${formatDuration(Date.now() - startSending)}.`);
    } catch (e) {
        console.log(`Error sending metrics ${e}`, 'error');
    }
};
