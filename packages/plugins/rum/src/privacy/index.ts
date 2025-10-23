// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { instrument } from '@datadog/js-instrumentation-wasm';
import type { GlobalContext, PluginOptions } from '@dd/core/types';

import { PLUGIN_NAME } from './constants';
import { buildTransformOptions } from './transform';
import type { PrivacyOptionsWithDefaults } from './types';

export const getPrivacyPlugin = (
    pluginOptions: PrivacyOptionsWithDefaults,
    context: GlobalContext,
): PluginOptions => {
    const log = context.getLogger(PLUGIN_NAME);

    const transformOptions = buildTransformOptions(
        pluginOptions.helperCodeExpression,
        context.bundler.name,
    );
    let dictionaryEntryCount = 0;
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
                    const result = instrument({ id, code }, transformOptions);
                    if (result.privacyDictionarySize === 0) {
                        return {
                            // This should be the same as the result from js-instrumentation-wasm
                            // returning the original code only to make it explicit for debugging purposes
                            code,
                        };
                    }
                    dictionaryEntryCount += result.privacyDictionarySize;
                    fileCount++;
                    return result;
                } catch (e) {
                    log.error(`Instrumentation Error: ${e}`, { forward: true });
                    return {
                        code,
                    };
                }
            },
        },
        buildEnd: () => {
            log.debug(
                `Privacy dictionary will include ${dictionaryEntryCount} entries across ${fileCount} files`,
                {
                    forward: true,
                    context: {
                        dictionaryEntryCount,
                        fileCount,
                    },
                },
            );
        },
    };
};
