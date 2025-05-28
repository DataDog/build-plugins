import type { GetPlugins } from '@dd/core/types';
import fs from 'node:fs';
import path from 'node:path';

import { PRIVACY_HELPERS_MODULE_ID, CONFIG_KEY, PLUGIN_NAME } from './constants';
import helpers from './generated/privacy-helpers.js-txt';
import { defaultPluginOptions } from './options';
import { buildTransformOptions, transformCode } from './transform';
import type { RumPrivacyOptions } from './types';

export { CONFIG_KEY, PLUGIN_NAME };

export type types = {
    // Add the types you'd like to expose here.
    RumPrivacyOptions: RumPrivacyOptions;
};

export const getPlugins: GetPlugins = ({ options, context }) => {
    const pluginOptions = {
        ...defaultPluginOptions,
        ...options,
    };
    const transformOptions = buildTransformOptions(pluginOptions);

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
            loadInclude(id) {
                return id.endsWith('main.ts');
            },
            async resolveId(source) {
                if (source === PRIVACY_HELPERS_MODULE_ID) {
                    return { id: PRIVACY_HELPERS_MODULE_ID };
                }
                return null;
            },
            async load(id) {
                if (id !== PRIVACY_HELPERS_MODULE_ID) {
                    return null;
                }
                // Define a custom loader.
                // https://rollupjs.org/plugin-development/#load
                return {
                    code: helpers,
                };
            },
            // webpack's id filter is outside of loader logic,
            // an additional hook is needed for better perf on webpack
            // transformInclude(id) {
            // },
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
            },
            esbuild: {
                setup(build) {
                    // Save the original value of 'write'. It must be set to 'false', or esbuild won't
                    // pass any files to us in onEnd().
                    const write = build.initialOptions.write ?? true;
                    build.initialOptions.write = false;

                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    build.onEnd((result: any) => {
                        const outputFiles = result?.outputFiles ?? [];

                        if (!write || outputFiles.length === 0) {
                            return;
                        }

                        // Since we disabled 'write', we need to write the output to disk ourselves.
                        if (write === undefined || write) {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            outputFiles.forEach((file: any) => {
                                fs.mkdirSync(path.dirname(file.path), { recursive: true });
                                fs.writeFileSync(file.path, file.contents);
                            });
                        }
                    });
                },
            },
        },
    ];
};
