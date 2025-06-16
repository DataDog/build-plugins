// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { instrument } from '@datadog/js-instrumentation-wasm';
import { type GetPlugins, type PluginOptions as CorePluginOptions } from '@dd/core/types';
import { createFilter } from '@rollup/pluginutils';
import fs from 'node:fs';
import path from 'node:path';

import { PRIVACY_HELPERS_MODULE_ID, PLUGIN_NAME } from './constants';
import { buildTransformOptions } from './transform';
import type { RumPrivacyOptions } from './types';
import { defaultPluginOptions } from './types';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME } from './constants';

export type types = {
    // Add the types you'd like to expose here.
    RumPrivacyOptions: RumPrivacyOptions;
};

export const getPlugins: GetPlugins = ({ options, context }) => {
    const log = context.getLogger(PLUGIN_NAME);
    const validatedOptions = validateOptions(options, log);

    if (validatedOptions.disabled) {
        return [];
    }

    const pluginOptions = {
        ...defaultPluginOptions,
        ...validatedOptions,
    };
    const transformOptions = buildTransformOptions(pluginOptions);
    const transformFilter = createFilter(pluginOptions.include, pluginOptions.exclude);

    // Read the privacy helpers code
    const privacyHelpersPath = path.join(
        __dirname,
        pluginOptions.module === 'cjs' ? './privacy-helpers.js' : './privacy-helpers.mjs',
    );

    const plugin: CorePluginOptions = {
        name: PLUGIN_NAME,
        // Enforce when the plugin will be executed.
        // Not supported by Rollup and ESBuild.
        // https://vitejs.dev/guide/api-plugin.html#plugin-ordering
        enforce: 'pre',
        // webpack's id filter is outside of loader logic,
        // an additional hook is needed for better perf on webpack
        async resolveId(source) {
            if (source === PRIVACY_HELPERS_MODULE_ID) {
                return { id: PRIVACY_HELPERS_MODULE_ID };
            }
            return null;
        },

        async load(id) {
            if (id === PRIVACY_HELPERS_MODULE_ID) {
                return { code: fs.readFileSync(privacyHelpersPath, 'utf8') };
            }
            return null;
        },
        // webpack's id filter is outside of loader logic,
        // an additional hook is needed for better perf on webpack
        transformInclude(id) {
            return transformFilter(id);
        },
        async transform(code, id) {
            return instrument({ id, code }, transformOptions);
        },
    };

    return [plugin];
};
