import { InjectPosition, type GetPlugins } from '@dd/core/types';
import { createFilter } from '@rollup/pluginutils';
import fs from 'fs';
import path from 'node:path';

import { PRIVACY_HELPERS_MODULE_ID, PLUGIN_NAME } from './constants';
import { defaultPluginOptions } from './options';
import { buildTransformOptions, transformCode } from './transform';
import type { RumPrivacyOptions } from './types';
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
        ...options,
    };
    const transformOptions = buildTransformOptions(pluginOptions);
    const transformFilter = createFilter(pluginOptions.include, pluginOptions.exclude);

    // Read the privacy helpers code
    const privacyHelpersPath = path.join(__dirname, './privacy-helpers.js');
    let privacyHelpersCode = '';
    // if the file does not exist throw an error
    if (!fs.existsSync(privacyHelpersPath)) {
        log.error(`Privacy helpers file not found at ${privacyHelpersPath}`);
    } else {
        privacyHelpersCode = fs.readFileSync(privacyHelpersPath, 'utf-8');
    }

    // Inject the privacy helpers code with entryAt option
    context.inject({
        type: 'code',
        position: InjectPosition.MIDDLE,
        value: privacyHelpersCode,
        entryAt: PRIVACY_HELPERS_MODULE_ID,
    });

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
            // webpack's id filter is outside of loader logic,
            // an additional hook is needed for better perf on webpack
            transformInclude(id) {
                return transformFilter(id);
            },
            async transform(code, id) {
                return {
                    code: (await transformCode(code, id, transformOptions)).code,
                };
            },
        },
    ];
};
