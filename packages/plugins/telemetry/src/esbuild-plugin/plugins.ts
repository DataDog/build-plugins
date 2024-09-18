// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginBuild } from 'esbuild';
import { performance } from 'perf_hooks';

import { formatModuleName, getValueContext } from '../common/helpers';
import { PLUGIN_NAME } from '../constants';
import type { TimingsMap, Timing, Value } from '../types';

const FN_TO_WRAP = ['onStart', 'onLoad', 'onResolve', 'onEnd'] as const;

const pluginsMap: TimingsMap = new Map();
const modulesMap: TimingsMap = new Map();

export const wrapPlugins = (build: PluginBuild, context: string) => {
    const plugins = build.initialOptions.plugins;
    if (plugins) {
        // We clone plugins so we don't pass modified options to other plugins.
        const initialPlugins = plugins.map((plugin) => {
            return {
                ...plugin,
            };
        });
        for (const plugin of plugins) {
            // Skip the current plugin.
            if (plugin.name.includes(PLUGIN_NAME)) {
                continue;
            }

            const oldSetup = plugin.setup;
            plugin.setup = async (esbuild) => {
                const newBuildObject = getNewBuildObject(esbuild, plugin.name, context);
                await oldSetup({
                    ...newBuildObject,
                    // Use non-modified plugins for other plugins
                    initialOptions: { ...newBuildObject.initialOptions, plugins: initialPlugins },
                });
            };
        }
    }
};

const getNewBuildObject = (
    build: PluginBuild,
    pluginName: string,
    context: string,
): PluginBuild => {
    const newBuildObject: any = Object.assign({}, build);
    for (const fn of FN_TO_WRAP) {
        newBuildObject[fn] = async (opts: any, cb: any) => {
            const pluginTiming: Timing = pluginsMap.get(pluginName) || {
                name: pluginName,
                increment: 0,
                duration: 0,
                events: {},
            };

            pluginTiming.events[fn] = pluginTiming.events[fn] || {
                name: fn,
                values: [],
            };
            const initialFunction: any = build[fn];
            return initialFunction(opts, async (...args: any[]) => {
                const modulePath = formatModuleName(args[0].path, context);
                const moduleTiming: Timing = modulesMap.get(modulePath) || {
                    name: modulePath,
                    increment: 0,
                    duration: 0,
                    events: {},
                };
                moduleTiming.events[fn] = moduleTiming.events[fn] || {
                    name: fn,
                    values: [],
                };
                const start = performance.now();

                try {
                    return await cb(...args);
                } finally {
                    const end = performance.now();
                    const duration = end - start;
                    const statsObject: Value = {
                        start,
                        end,
                        duration,
                        context: getValueContext(args),
                    };

                    pluginTiming.events[fn]!.values.push(statsObject);
                    pluginTiming.duration += duration;
                    pluginTiming.increment += 1;
                    pluginsMap.set(pluginName, pluginTiming);

                    moduleTiming.events[fn].values.push(statsObject);
                    moduleTiming.duration += duration;
                    moduleTiming.increment += 1;
                    modulesMap.set(modulePath, moduleTiming);
                }
            });
        };
    }
    return newBuildObject;
};

export const getResults = () => ({ plugins: pluginsMap, modules: modulesMap });
