// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { instrument } from '@datadog/js-instrumentation-wasm';
import type { GlobalContext, PluginOptions } from '@dd/core/types';
import { createFilter } from '@rollup/pluginutils';
import fs from 'node:fs';
import path from 'node:path';

import { PRIVACY_HELPERS_MODULE_ID, PLUGIN_NAME } from './constants';
import { buildTransformOptions } from './transform';
import type { PrivacyOptions } from './types';

export const getPrivacyPlugin = (
    pluginOptions: PrivacyOptions,
    context: GlobalContext,
): PluginOptions | undefined => {
    const log = context.getLogger(PLUGIN_NAME);

    if (pluginOptions.disabled) {
        return;
    }

    const transformOptions = buildTransformOptions(pluginOptions);
    const transformFilter = createFilter(pluginOptions.include, pluginOptions.exclude);
    const privacyHelpersModuleId = pluginOptions.helpersModule ?? PRIVACY_HELPERS_MODULE_ID;
    return {
        name: PLUGIN_NAME,
        // Enforce when the plugin will be executed.
        // Not supported by Rollup and ESBuild.
        // https://vitejs.dev/guide/api-plugin.html#plugin-ordering
        enforce: 'post',
        // webpack's id filter is outside of loader logic,
        // an additional hook is needed for better perf on webpack
        async resolveId(source) {
            if (source.includes(privacyHelpersModuleId)) {
                return { id: source };
            }
            return null;
        },

        loadInclude(id) {
            if (id.includes(privacyHelpersModuleId)) {
                return true;
            }
            return false;
        },

        async load(id) {
            let privacyHelpersPath: string;
            if (id.includes(privacyHelpersModuleId)) {
                if (id.endsWith('.cjs')) {
                    privacyHelpersPath = path.join(__dirname, 'privacy-helpers.js');
                } else {
                    privacyHelpersPath = path.join(__dirname, 'privacy-helpers.mjs');
                }
                return { code: fs.readFileSync(privacyHelpersPath, 'utf8'), map: null };
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
                if (
                    context.bundler.name === 'esbuild' ||
                    context.bundler.name === 'webpack' ||
                    context.bundler.name === 'rspack'
                ) {
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
