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
    let dictionarySize = 0;
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
                    dictionarySize += result.privacyDictionarySize;
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
            log.debug(`Instrumentation result - privacy dictionary size: ${dictionarySize}`, {
                forward: true,
            });
        },
    };
};
