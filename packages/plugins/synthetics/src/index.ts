// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, GetPlugins, Options } from '@dd/core/types';
import chalk from 'chalk';

import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import type { SyntheticsOptions, SyntheticsOptionsWithDefaults } from './types';

export { CONFIG_KEY, PLUGIN_NAME };

export const helpers = {
    // Add the helpers you'd like to expose here.
};

export type types = {
    // Add the types you'd like to expose here.
    SyntheticsOptions: SyntheticsOptions;
};

// Deal with validation and defaults here.
export const validateOptions = (config: Options): SyntheticsOptionsWithDefaults => {
    const validatedOptions: SyntheticsOptionsWithDefaults = {
        // We don't want to disable it by default.
        disabled: false,
        ...config[CONFIG_KEY],
    };
    return validatedOptions;
};

export const getPlugins: GetPlugins = (opts: Options, context: GlobalContext) => {
    const log = context.getLogger(PLUGIN_NAME);
    // Verify configuration.
    const options = validateOptions(opts);

    if (options.disabled) {
        return [];
    }

    return [
        {
            name: PLUGIN_NAME,
            async writeBundle() {
                // Execute code after the bundle is written.
                // https://rollupjs.org/plugin-development/#writebundle
                const { BUILD_PLUGINS_S8S_LOCAL, BUILD_PLUGINS_S8S_PORT } = process.env;
                const runServer =
                    !options.disabled && BUILD_PLUGINS_S8S_LOCAL === '1' && BUILD_PLUGINS_S8S_PORT;

                if (BUILD_PLUGINS_S8S_LOCAL && !BUILD_PLUGINS_S8S_PORT) {
                    log.warn(
                        `Synthetics local server port is not set, please use ${chalk.bold.yellow('$BUILD_PLUGINS_S8S_PORT=1234')}.`,
                    );
                }

                if (!BUILD_PLUGINS_S8S_LOCAL && BUILD_PLUGINS_S8S_PORT) {
                    log.warn(
                        `Got server port but Synthetics local server is disabled, please use ${chalk.bold.yellow('$BUILD_PLUGINS_S8S_LOCAL=1')}.`,
                    );
                }
                if (runServer) {
                    const port = +BUILD_PLUGINS_S8S_PORT;
                    log.info(
                        `Starting Synthetics local server on ${chalk.bold.cyan(`http://127.0.0.1:${port}`)}.`,
                    );
                }
            },
        },
    ];
};
