// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-console */

import { Plugin, PluginBuild } from 'esbuild';
import { performance } from 'perf_hooks';

import { TimingsMap, Timing, Value } from '../types';
import { getContext, formatModuleName } from '../helpers';
import { BaseClass } from '../BaseClass';

enum FN_TO_WRAP {
    START = 'onStart',
    LOAD = 'onLoad',
    RESOLVE = 'onResolve',
    END = 'onEnd',
}

const pluginsMap: TimingsMap = new Map();
const modulesMap: TimingsMap = new Map();

export const wrapPlugins = (self: BaseClass, build: PluginBuild, plugins?: Plugin[]) => {
    if (plugins) {
        for (const plugin of plugins) {
            const newBuildObject = getNewBuildObject(self, build, plugin.name);
            const oldSetup = plugin.setup;
            plugin.setup = () => {
                oldSetup(newBuildObject);
            };
        }
    }
};

const getNewBuildObject = (
    self: BaseClass,
    build: PluginBuild,
    pluginName: string
): PluginBuild => {
    const newBuildObject: any = Object.assign({}, build);
    for (const fn of Object.values(FN_TO_WRAP)) {
        newBuildObject[fn] = async (opts: any, cb: any) => {
            // TODO Remove debug.
            if (pluginsMap.get(pluginName)) {
                console.log(`Already got the timing for ${pluginName}`, pluginsMap.get(pluginName));
            }

            const pluginTiming: Timing = pluginsMap.get(pluginName) || {
                name: pluginName,
                increment: 0,
                duration: 0,
                events: {},
            };

            // TODO Remove debug.
            if (pluginTiming.events[fn]) {
                console.log(
                    `Already got the timing for ${pluginName}.${fn}`,
                    pluginTiming.events[fn]
                );
            }

            pluginTiming.events[fn] = pluginTiming.events[fn] || {
                name: fn,
                values: [],
            };

            return build[fn](opts, async (...args: any[]) => {
                // console.log(`${pluginName} on ${fn} has path?`, args[0].path ? 'true' : 'false');
                const modulePath = formatModuleName(args[0].path, self.options.context!);
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
                        context: getContext(args),
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
