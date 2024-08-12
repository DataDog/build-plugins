// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext } from '@dd/core/types';

import type { LocalModule, TimingsMap, Metric } from '../../types';
import { flattened, getType } from '../helpers';

interface GeneralReport {
    modules?: number;
    chunks?: number;
    assets?: number;
    errors?: number;
    warnings?: number;
    entries?: number;
    duration?: number;
}

export const getGeneralReport = (globalContext: GlobalContext): GeneralReport => {
    return {
        modules: globalContext.build.inputs ? globalContext.build.inputs.length : 0,
        assets: globalContext.build.outputs ? globalContext.build.outputs.length : undefined,
        warnings: globalContext.build.warnings.length,
        errors: globalContext.build.errors.length,
        entries: globalContext.build.entries ? globalContext.build.entries.length : undefined,
        duration: globalContext.build.duration,
    };
};

export const getGenerals = (report: GeneralReport): Metric[] => {
    const { duration, ...extracted } = report;
    const metrics: Metric[] = [];

    for (const [key, value] of Object.entries(extracted)) {
        metrics.push({
            metric: `${key}.count`,
            type: 'count',
            value,
            tags: [],
        });
    }

    if (report.duration) {
        metrics.push({
            metric: 'compilation.duration',
            type: 'duration',
            value: report.duration,
            tags: [],
        });
    }

    return metrics;
};

export const getDependencies = (modules: LocalModule[]): Metric[] =>
    flattened(
        modules.map((m) => [
            {
                metric: 'modules.dependencies',
                type: 'count',
                value: m.dependencies.length,
                tags: [`moduleName:${m.name}`, `moduleType:${getType(m.name)}`],
            },
            {
                metric: 'modules.dependents',
                type: 'count',
                value: m.dependents.length,
                tags: [`moduleName:${m.name}`, `moduleType:${getType(m.name)}`],
            },
        ]),
    );

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
