/* eslint-disable no-console */

import { Plugin, PluginBuild } from 'esbuild';
import { performance } from 'perf_hooks';

import { Context } from '../types';

enum FN_TO_WRAP {
    START = 'onStart',
    LOAD = 'onLoad',
    RESOLVE = 'onResolve',
    END = 'onEnd',
}

export interface HookValue {
    start: number;
    end: number;
    duration: number;
    context: Context[];
}

export interface Timing {
    name: string;
    duration: number;
    hooks: {
        [key in FN_TO_WRAP]?: {
            name: string;
            values: HookValue[];
        };
    };
}

// TODO Merge this with ./src/types
export type PluginsMap = Map<string, Timing>;

const pluginsMap: PluginsMap = new Map();

export const wrapPlugins = (build: PluginBuild, plugins?: Plugin[]) => {
    if (plugins) {
        for (const plugin of plugins) {
            const newBuildObject = getNewBuildObject(build, pluginsMap, plugin.name);
            const oldSetup = plugin.setup;
            plugin.setup = () => {
                oldSetup(newBuildObject);
            };
        }
    }
};

const getContext = (args: any[]): Context[] => {
    return args.map((arg) => ({
        type: arg?.constructor?.name ?? typeof arg,
        name: arg?.name,
        value: typeof arg === 'string' ? arg : undefined,
    }));
};

const getNewBuildObject = (
    build: PluginBuild,
    map: PluginsMap,
    pluginName: string
): PluginBuild => {
    const newBuildObject: any = Object.assign({}, build);
    for (const fn of Object.values(FN_TO_WRAP)) {
        newBuildObject[fn] = async (opts: any, cb: any) => {
            // TODO Remove debug.
            if (map.get(pluginName)) {
                console.log(`Already got the timing for ${pluginName}`, map.get(pluginName));
            }

            const timing: Timing = map.get(pluginName) || {
                name: pluginName,
                duration: 0,
                hooks: {},
            };

            // TODO Remove debug.
            if (timing.hooks[fn]) {
                console.log(`Already got the timing for ${pluginName}.${fn}`, timing.hooks[fn]);
            }

            timing.hooks[fn] = timing.hooks[fn] || {
                name: fn,
                values: [],
            };

            return build[fn](opts, async (...args: any[]) => {
                const start = performance.now();

                try {
                    return await cb(...args);
                } finally {
                    const end = performance.now();
                    const duration = end - start;
                    timing.hooks[fn]!.values.push({
                        start,
                        end,
                        duration,
                        context: getContext(args),
                    });
                    timing.duration += duration;
                    map.set(pluginName, timing);
                }
            });
        };
    }
    return newBuildObject;
};
