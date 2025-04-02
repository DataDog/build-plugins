// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { HOST_NAME } from '@dd/core/constants';
import type {
    CustomPluginOptions,
    GetCustomPlugins,
    GetInternalPlugins,
    GetPluginsArg,
    GetPlugins,
    GlobalContext,
    Logger,
    PluginOptions,
    GetProfiledPlugins,
    CustomHooks,
} from '@dd/core/types';
import type { UnpluginOptions } from 'unplugin';

// Unplugin universal hooks.
const UNPLUGIN_HOOKS = [
    'buildEnd',
    'buildStart',
    'load',
    'loadInclude',
    'resolveId',
    'transform',
    'transformInclude',
    'watchChange',
    'writeBundle',
] as const;

// Custom hooks.
const CUSTOM_HOOKS = ['cwd', 'init', 'buildReport', 'bundlerReport', 'git'] as const;

// All the hooks that we want to profile.
const HOOKS_TO_PROFILE = [...UNPLUGIN_HOOKS, ...CUSTOM_HOOKS];

// Define a type that represents all possible hook names
type HookName = (typeof HOOKS_TO_PROFILE)[number];
type PluginHookName = keyof (PluginOptions | CustomPluginOptions);
type HookFn = NonNullable<
    CustomHooks[(typeof CUSTOM_HOOKS)[number]] | UnpluginOptions[(typeof UNPLUGIN_HOOKS)[number]]
>;

export const wrapHook = (pluginName: string, hookName: HookName, hook: HookFn, log: Logger) => {
    return (...args: Parameters<HookFn>) => {
        const timer = log.time(`hook | ${pluginName} | ${hookName}`);
        // @ts-expect-error, can't type "args" correctly. "A spread argument must either have a tuple type or be passed to a rest parameter."
        const result = hook(...args);

        if (result instanceof Promise) {
            return result.finally(() => {
                timer.end();
            });
        }

        timer.end();
        return result;
    };
};

export const wrapPlugin = (plugin: PluginOptions | CustomPluginOptions, log: Logger) => {
    const wrappedPlugin: PluginOptions | CustomPluginOptions = {
        ...plugin,
    };

    // Wrap all the hooks that we want to profile.
    for (const hookName of HOOKS_TO_PROFILE) {
        const hook = plugin[hookName as PluginHookName];
        if (hook) {
            wrappedPlugin[hookName as PluginHookName] = wrapHook(plugin.name, hookName, hook, log);
        }
    }

    return wrappedPlugin;
};

export const wrapGetPlugins = (
    context: GlobalContext,
    getPlugins: GetPlugins | GetCustomPlugins | GetInternalPlugins,
    name: string,
): GetProfiledPlugins => {
    const log = context.getLogger(HOST_NAME);
    // 1. Return the getPlugins function wrapped, so we can measure the initialization time.
    //      a. The wrapper will parse all the plugins that are returned.
    //      b. The wrapper will wrap all the unplugin hooks used by each plugin.
    // 2. Return the wrapped function.
    return (arg: GetPluginsArg) => {
        // Start our timer.
        const initTimer = log.time(`hook | init ${name}`);

        const plugins = getPlugins(arg).map((plugin) => wrapPlugin(plugin, log));

        // Tag our timer with the plugin names.
        const pluginNames = plugins.map((plugin) => `plugin:${plugin.name}`);
        initTimer.tag(pluginNames);

        // Wrap all the plugins returned.
        initTimer.end();
        return plugins;
    };
};
