// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPlugins, GlobalContext, PluginOptions } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';

import { CONFIG_KEY, PLUGIN_NAME, RUNTIME_STUBS } from './constants';
import { transformCode } from './transform';
import type { LiveDebuggerOptions, LiveDebuggerOptionsWithDefaults } from './types';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME };

const DD_LD_LIMIT = Number(process.env.DD_LD_LIMIT) || Infinity;

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
    let failedCount = 0;
    let skippedByCommentCount = 0;
    let skippedFileCount = 0;
    let skippedUnsupportedCount = 0;
    let transformedFileCount = 0;
    let totalFunctions = 0;
    let totalFilesWithFunctions = 0;

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
                // Enforce include/exclude patterns at runtime because unplugin's
                // native filter is not applied in bundler child compilations
                // (e.g., web worker bundles in rspack/webpack).
                if (pluginOptions.include.length > 0) {
                    const included = pluginOptions.include.some((pattern) =>
                        typeof pattern === 'string' ? id.includes(pattern) : pattern.test(id),
                    );
                    if (!included) {
                        return { code };
                    }
                }

                for (const pattern of pluginOptions.exclude) {
                    const excluded =
                        typeof pattern === 'string' ? id.includes(pattern) : pattern.test(id);
                    if (excluded) {
                        return { code };
                    }
                }

                if (totalFilesWithFunctions >= DD_LD_LIMIT) {
                    return { code };
                }

                try {
                    const result = transformCode({
                        code,
                        filePath: id,
                        buildRoot: context.buildRoot,
                        honorSkipComments: pluginOptions.honorSkipComments,
                        functionTypes: pluginOptions.functionTypes,
                        namedOnly: pluginOptions.namedOnly,
                    });

                    instrumentedCount += result.instrumentedCount;
                    totalFunctions += result.totalFunctions;
                    failedCount += result.failedCount;
                    skippedByCommentCount += result.skippedByCommentCount;
                    skippedFileCount += result.skippedFileCount;
                    skippedUnsupportedCount += result.skippedUnsupportedCount;

                    if (result.totalFunctions > 0) {
                        totalFilesWithFunctions++;
                    }

                    if (result.instrumentedCount === 0) {
                        return {
                            // No changes, return original code
                            code,
                        };
                    }

                    transformedFileCount++;

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
            if (totalFunctions > 0) {
                log.info(
                    `Live Debugger: ${instrumentedCount}/${totalFunctions} functions instrumented across ${transformedFileCount}/${totalFilesWithFunctions} files`,
                    {
                        forward: true,
                        context: {
                            failedCount,
                            skippedByCommentCount,
                            skippedFileCount,
                            skippedUnsupportedCount,
                            totalFilesWithFunctions,
                            instrumentedCount,
                            totalFunctions,
                            transformedFileCount,
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

    // Inject no-op stubs for the runtime globals so instrumented code
    // doesn't crash when the Datadog Browser Debugger SDK is absent.
    // The SDK's init() overwrites these with the real implementations.
    context.inject({
        type: 'code',
        position: InjectPosition.BEFORE,
        injectIntoAllChunks: true,
        value: RUNTIME_STUBS,
    });

    return [getLiveDebuggerPlugin(validatedOptions, context)];
};
