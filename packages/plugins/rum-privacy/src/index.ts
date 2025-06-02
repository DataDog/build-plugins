import type { GetPlugins } from '@dd/core/types';
import { createFilter } from '@rollup/pluginutils';
// import fs from 'node:fs';
// import path from 'node:path';

import { PRIVACY_HELPERS_MODULE_ID, CONFIG_KEY, PLUGIN_NAME } from './constants';
import helpers from './generated/privacy-helpers.js-txt';
import { defaultPluginOptions } from './options';
import { buildTransformOptions, transformCode } from './transform';
import type { RumPrivacyOptions } from './types';

export { CONFIG_KEY, PLUGIN_NAME } from './constants';

export type types = {
    // Add the types you'd like to expose here.
    RumPrivacyOptions: RumPrivacyOptions;
};

export const getPlugins: GetPlugins = ({ options, context }) => {
    if (!options[CONFIG_KEY]) {
        // TODO: Implement disabled option.
        return [];
    }
    const pluginOptions = {
        ...defaultPluginOptions,
        ...options,
    };
    const transformOptions = buildTransformOptions(pluginOptions);
    const transformFilter = createFilter(pluginOptions.include, pluginOptions.exclude);

    // const log = context.getLogger(PLUGIN_NAME);

    return [
        {
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
                if (id.includes(PRIVACY_HELPERS_MODULE_ID)) {
                    // Define a custom loader.
                    // https://rollupjs.org/plugin-development/#load
                    return {
                        code: helpers,
                    };
                }
            },
            // webpack's id filter is outside of loader logic,
            // an additional hook is needed for better perf on webpack
            transformInclude(id) {
                return transformFilter(id);
            },
            async transform(code, id) {
                // Transform individual modules.
                // https://rollupjs.org/plugin-development/#transform
                return {
                    code: (await transformCode(code, id, transformOptions)).code,
                };
            },
            async buildEnd() {
                // Execute code after the build ends.
                // https://rollupjs.org/plugin-development/#buildend
            }
        },
    ];
};
