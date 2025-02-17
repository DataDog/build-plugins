// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { CustomHooks, GlobalContext, PluginOptions } from '@dd/core/types';

import { PLUGIN_NAME } from './constants';

export { PLUGIN_NAME } from './constants';

export const getCustomHooksPlugins = (context: GlobalContext): PluginOptions[] => {
    const log = context.getLogger(PLUGIN_NAME);

    const executeHooks =
        (async: boolean) =>
        (hookName: keyof CustomHooks, ...hookArgs: any[]) => {
            const errors: string[] = [];
            const proms: Promise<void>[] = [];

            for (const plugin of context.plugins) {
                if (!(hookName in plugin)) {
                    continue;
                }

                const hookFn: any = plugin[hookName];
                if (typeof hookFn !== 'function') {
                    errors.push(
                        `Plugin "${plugin.name}" has an invalid hook type for "${hookName}". [${typeof hookFn}]`,
                    );
                    continue;
                }

                try {
                    const result: any = hookFn(...hookArgs);
                    proms.push(result);

                    // Confirm that the result is not an unsupported Promise.
                    if (!async && result && typeof result.then === 'function') {
                        errors.push(
                            `Plugin "${plugin.name}" returned a promise on the non async hook "${hookName}".`,
                        );
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

            return Promise.all(proms);
        };

    // Define the hook functions.
    context.hook = executeHooks(false);
    // Define the asyncHook functions.
    context.asyncHook = executeHooks(true);

    return [
        {
            name: PLUGIN_NAME,
            enforce: 'pre',
        },
    ];
};
