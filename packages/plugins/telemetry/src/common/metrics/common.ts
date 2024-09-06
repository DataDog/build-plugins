// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { TimingsMap, Metric } from '../../types';

export const getPlugins = (plugins: TimingsMap): Metric[] => {
    const metrics: Metric[] = [];

    metrics.push({
        metric: 'plugins.count',
        type: 'count',
        value: plugins.size,
        tags: [],
    });

    for (const plugin of plugins.values()) {
        let pluginDuration = 0;
        let pluginCount = 0;

        for (const hook of Object.values(plugin.events)) {
            let hookDuration = 0;
            pluginCount += hook.values.length;
            for (const v of hook.values) {
                const duration = v.end - v.start;
                hookDuration += duration;
                pluginDuration += duration;
            }
            metrics.push(
                {
                    metric: 'plugins.hooks.duration',
                    type: 'duration',
                    value: hookDuration,
                    tags: [`pluginName:${plugin.name}`, `hookName:${hook.name}`],
                },
                {
                    metric: 'plugins.hooks.increment',
                    type: 'count',
                    value: hook.values.length,
                    tags: [`pluginName:${plugin.name}`, `hookName:${hook.name}`],
                },
            );
        }

        metrics.push(
            {
                metric: 'plugins.duration',
                type: 'duration',
                value: pluginDuration,
                tags: [`pluginName:${plugin.name}`],
            },
            {
                metric: 'plugins.increment',
                type: 'count',
                value: pluginCount,
                tags: [`pluginName:${plugin.name}`],
            },
        );
    }

    return metrics;
};

export const getLoaders = (loaders: TimingsMap): Metric[] => {
    const metrics: Metric[] = [];

    metrics.push({
        metric: 'loaders.count',
        type: 'count',
        value: loaders.size,
        tags: [],
    });

    for (const loader of loaders.values()) {
        metrics.push(
            {
                metric: 'loaders.duration',
                type: 'duration',
                value: loader.duration,
                tags: [`loaderName:${loader.name}`],
            },
            {
                metric: 'loaders.increment',
                type: 'count',
                value: loader.increment,
                tags: [`loaderName:${loader.name}`],
            },
        );
    }

    return metrics;
};
