// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPlugins, GlobalContext, PluginOptions } from '@dd/core/types';

import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import { transformCode } from './transform';
import type { LiveDebuggerOptions, LiveDebuggerOptionsWithDefaults } from './types';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME };

// Export types for factory integration
export type types = {
    LiveDebuggerOptions: LiveDebuggerOptions;
};

export const getLiveDebuggerPlugin = (
    pluginOptions: LiveDebuggerOptionsWithDefaults,
    context: GlobalContext,
): PluginOptions => {
    const log = context.getLogger(PLUGIN_NAME);

    let instrumentedCount = 0;
    let totalFunctions = 0;
    let fileCount = 0;

    return {
        name: PLUGIN_NAME,
        // Enforce when the plugin will be executed.
        // Not supported by Rollup and ESBuild.
        // https://vitejs.dev/guide/api-plugin.html#plugin-ordering
        enforce: 'post',
        transform: {
            filter: {
                id: {
                    include: pluginOptions.include,
                    exclude: pluginOptions.exclude,
                },
            },
            handler(code, id) {
                try {
                    const result = transformCode({
                        code,
                        filePath: id,
                        buildRoot: context.buildRoot,
                        skipHotFunctions: pluginOptions.skipHotFunctions,
                    });

                    if (result.instrumentedCount === 0) {
                        return {
                            // No changes, return original code
                            code,
                        };
                    }

                    instrumentedCount += result.instrumentedCount;
                    totalFunctions += result.totalFunctions;
                    fileCount++;

                    return {
                        code: result.code,
                        map: result.map,
                    };
                } catch (e) {
                    log.error(`Instrumentation Error in ${id}: ${e}`, { forward: true });
                    return {
                        code,
                    };
                }
            },
        },
        buildEnd: () => {
            if (instrumentedCount > 0) {
                log.info(
                    `Live Debugger: ${instrumentedCount}/${totalFunctions} functions instrumented across ${fileCount} files`,
                    {
                        forward: true,
                        context: {
                            instrumentedCount,
                            totalFunctions,
                            fileCount,
                        },
                    },
                );
            }
        },
    };
};

export const getPlugins: GetPlugins = ({ options, context }) => {
    const log = context.getLogger(PLUGIN_NAME);
    const validatedOptions = validateOptions(options, log);

    if (!validatedOptions.enable) {
        return [];
    }

    return [getLiveDebuggerPlugin(validatedOptions, context)];
};
