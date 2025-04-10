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
    GetWrappedPlugins,
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

// All the hooks that we want to trace.
const HOOKS_TO_TRACE = [...UNPLUGIN_HOOKS, ...CUSTOM_HOOKS];

// Represents the hook names a plugin can have (including those we're not tracing).
type PluginHookName = keyof (PluginOptions | CustomPluginOptions);
// Represents the custom hook names.
type CustomHookName = (typeof CUSTOM_HOOKS)[number];
// Represents the unplugin hook names.
type UnpluginHookName = (typeof UNPLUGIN_HOOKS)[number];
// Represents the hook names that we want to trace.
type HookName = CustomHookName | UnpluginHookName;
// Represents the function called by a hook that we want to trace.
type HookFn = NonNullable<CustomHooks[CustomHookName] | UnpluginOptions[UnpluginHookName]>;

export const wrapHook = (pluginName: string, hookName: HookName, hook: HookFn, log: Logger) => {
    return (...args: Parameters<HookFn>) => {
        const timer = log.time(`hook | ${pluginName} | ${hookName}`, { log: false });
        // @ts-expect-error, can't type "args" correctly: "A spread argument must either have a tuple type or be passed to a rest parameter."
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

    // Wrap all the hooks that we want to trace.
    for (const hookName of HOOKS_TO_TRACE) {
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
): GetWrappedPlugins => {
    const log = context.getLogger(HOST_NAME);
    // Return the getPlugins function wrapped, so we can measure the initialization time.
    return (arg: GetPluginsArg) => {
        // Start our timer.
        const initTimer = log.time(`hook | init ${name}`, { log: false });

        // Wrap all the plugins that are returned by the initial getPlugins function.
        const wrappedPlugins = getPlugins(arg).map((plugin) => wrapPlugin(plugin, log));

        // Tag our timer with the plugin names.
        const pluginNames = wrappedPlugins.map((plugin) => `plugin:${plugin.name}`);
        initTimer.tag(pluginNames);

        // End of initialization.
        initTimer.end();
        return wrappedPlugins;
    };
};
