// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { formatDuration } from '@dd/core/helpers';
import type { Logger } from '@dd/core/log';

import { PLUGIN_NAME } from '../../constants';
import type { Context, OptionsDD } from '../../types';
import { getMetrics } from '../aggregator';
import { getMetric } from '../helpers';

export const addMetrics = (context: Context, optionsDD: OptionsDD, log: Logger, cwd: string) => {
    const { report, bundler } = context;

    context.metrics = context.metrics || [];
    try {
        context.metrics = getMetrics(optionsDD, report, bundler, cwd);
    } catch (e) {
        const stack = e instanceof Error ? e.stack : e;
        log(`Couldn't aggregate metrics: ${stack}`, 'error');
    }
};

export const processMetrics = async (context: Context, optionsDD: OptionsDD, log: Logger) => {
    const { start } = context;
    const duration = Date.now() - start;

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

    log(`Took ${formatDuration(duration)}.`);
};
