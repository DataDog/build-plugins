// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { formatDuration } from '@dd/core/helpers';
import type { Logger } from '@dd/core/log';
import type { GlobalContext } from '@dd/core/types';

import { PLUGIN_NAME } from '../../constants';
import type { BundlerContext, OptionsDD } from '../../types';
import { getMetrics } from '../aggregator';
import { getMetric } from '../helpers';

export const addMetrics = (
    bundlerContext: BundlerContext,
    globalContext: GlobalContext,
    optionsDD: OptionsDD,
    log: Logger,
) => {
    const { report, bundler } = bundlerContext;

    if (!report || !bundler) {
        bundlerContext.metrics = bundlerContext.metrics || [];
        log('No report found.', 'warn');
        return;
    }

    try {
        bundlerContext.metrics = getMetrics(bundlerContext, globalContext, optionsDD);
    } catch (e) {
        const stack = e instanceof Error ? e.stack : e;
        log(`Couldn't aggregate metrics: ${stack}`, 'error');
    }
};

export const processMetrics = async (
    bundlerContext: BundlerContext,
    optionsDD: OptionsDD,
    log: Logger,
) => {
    const { start } = bundlerContext;
    const duration = Date.now() - start;

    bundlerContext.metrics = bundlerContext.metrics || [];
    // We're missing the duration of this hook for our plugin.
    bundlerContext.metrics.push(
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
