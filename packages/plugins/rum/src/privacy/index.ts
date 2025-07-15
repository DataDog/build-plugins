// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { instrument } from '@datadog/js-instrumentation-wasm';
import { readFileSync } from '@dd/core/helpers/fs';
import type { GlobalContext, PluginOptions } from '@dd/core/types';
import { createFilter } from '@rollup/pluginutils';
import path from 'node:path';

import { PLUGIN_NAME, PRIVACY_HELPERS_FILE_NAME } from './constants';
import { buildTransformOptions } from './transform';
import type { PrivacyOptionsWithDefaults } from './types';

export const getPrivacyPlugin = (
    pluginOptions: PrivacyOptionsWithDefaults,
    context: GlobalContext,
): PluginOptions | undefined => {
    const log = context.getLogger(PLUGIN_NAME);

    if (pluginOptions.disabled) {
        return;
    }

    const transformOptions = buildTransformOptions(pluginOptions);
    const transformFilter = createFilter(pluginOptions.include, pluginOptions.exclude);
    const { helpersModule } = pluginOptions;
    return {
        name: PLUGIN_NAME,
        // Enforce when the plugin will be executed.
        // Not supported by Rollup and ESBuild.
        // https://vitejs.dev/guide/api-plugin.html#plugin-ordering
        enforce: 'post',
        // webpack's id filter is outside of loader logic,
        // an additional hook is needed for better perf on webpack
        async resolveId(source) {
            if (source.includes(helpersModule)) {
                return { id: source };
            }
            return null;
        },

        loadInclude(id) {
            if (id.includes(helpersModule)) {
                return true;
            }
            return false;
        },

        async load(id) {
            if (id.includes(helpersModule)) {
                const filename = `${path.join(__dirname, PRIVACY_HELPERS_FILE_NAME)}.${id.endsWith('.cjs') ? 'js' : 'mjs'}`;
                return { code: readFileSync(filename), map: null };
            }
            return null;
        },
        // webpack's id filter is outside of loader logic,
        // an additional hook is needed for better perf on webpack
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
                const result = instrument({ id, code }, transformOptions);
                return result;
            } catch (e) {
                log.error(`Instrumentation Error: ${e}`);
                return {
                    code,
                };
            }
        },
    };
};
