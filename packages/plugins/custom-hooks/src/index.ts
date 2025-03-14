// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, PluginOptions, TriggerHook } from '@dd/core/types';

import { PLUGIN_NAME } from './constants';

export { PLUGIN_NAME } from './constants';

export const getCustomHooksPlugins = (context: GlobalContext): PluginOptions[] => {
    const log = context.getLogger(PLUGIN_NAME);

    const executeHooks =
        (async: boolean): TriggerHook<Promise<void[]> | void> =>
        (hookName, ...hookArgs) => {
            const timeHook = log.time(`hook | ${hookName}`);
            const errors: string[] = [];
            const proms: Promise<void>[] = [];

            for (const plugin of context.plugins) {
                if (!(hookName in plugin)) {
                    continue;
                }

                const hookFn = plugin[hookName];
                if (typeof hookFn !== 'function') {
                    errors.push(
                        `Plugin "${plugin.name}" has an invalid hook type for "${hookName}". [${typeof hookFn}]`,
                    );
                    continue;
                }

                try {
                    // Re-typing to take over typechecking.
                    const result: any = hookFn(...(hookArgs as any[]));

                    if (typeof result?.then === 'function') {
                        // Confirm that the result is not an unsupported Promise.
                        if (!async) {
                            errors.push(
                                `Plugin "${plugin.name}" returned a promise on the non async hook "${hookName}".`,
                            );
                        }
                        proms.push(result);
                    }
                } catch (e) {
                    errors.push(`Plugin "${plugin.name}" errored on hook "${hookName}". [${e}]`);
                }
            }

            if (errors.length > 0) {
                for (const error of errors) {
                    log.error(error);
                }
                throw new Error(`Some plugins errored during the hook execution.`);
            }

            return Promise.all(proms).finally(() => timeHook.end());
        };

    // Define the hook functions.
    context.hook = executeHooks(false);
    // Define the asyncHook functions.
    context.asyncHook = executeHooks(true) as TriggerHook<Promise<void[]>>;

    return [
        {
            name: PLUGIN_NAME,
            enforce: 'pre',
        },
    ];
};
