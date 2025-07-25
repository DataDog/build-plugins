// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { instrument } from '@datadog/js-instrumentation-wasm';
import type { GlobalContext, PluginOptions } from '@dd/core/types';
import { createFilter } from '@rollup/pluginutils';

import { PLUGIN_NAME } from './constants';
import { buildTransformOptions } from './transform';
import type { PrivacyOptionsWithDefaults } from './types';

export const getPrivacyPlugin = (
    pluginOptions: PrivacyOptionsWithDefaults,
    context: GlobalContext,
): PluginOptions => {
    const log = context.getLogger(PLUGIN_NAME);

    const transformOptions = buildTransformOptions(pluginOptions.helperCodeExpression);
    const transformFilter = createFilter(pluginOptions.include, pluginOptions.exclude);
    return {
        name: PLUGIN_NAME,
        // Enforce when the plugin will be executed.
        // Not supported by Rollup and ESBuild.
        // https://vitejs.dev/guide/api-plugin.html#plugin-ordering
        enforce: 'post',
        transformInclude(id) {
            return transformFilter(id);
        },
        async transform(code, id) {
            try {
                if (['esbuild', 'webpack', 'rspack'].includes(context.bundler.name)) {
                    transformOptions.output = {
                        ...transformOptions.output,
                        inlineSourceMap: false,
                        embedCodeInSourceMap: true,
                    };
                }
                return instrument({ id, code }, transformOptions);
            } catch (e) {
                log.error(`Instrumentation Error: ${e}`);
                return {
                    code,
                };
            }
        },
    };
};
