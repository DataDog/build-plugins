// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options, Logger, GlobalContext } from '@dd/core/types';
import chalk from 'chalk';

import { CONFIG_KEY, DEFAULT_PORT } from './constants';
import type { SyntheticsOptionsWithDefaults } from './types';

export const validateOptions = (
    config: Options,
    context: GlobalContext,
    log: Logger,
): SyntheticsOptionsWithDefaults => {
    // Get values from environment.
    const { BUILD_PLUGINS_S8S_PORT } = process.env;

    // Which port has been requested?
    // This can either be enabled via env var or configuration.
    const askedPort = BUILD_PLUGINS_S8S_PORT || config[CONFIG_KEY]?.server?.port;

    // Define defaults.
    const validatedOptions: SyntheticsOptionsWithDefaults = {
        // We don't want to disable it by default.
        disabled: false,
        ...config[CONFIG_KEY],
        server: {
            run: !!BUILD_PLUGINS_S8S_PORT,
            port: BUILD_PLUGINS_S8S_PORT ? +BUILD_PLUGINS_S8S_PORT : DEFAULT_PORT,
            ...config[CONFIG_KEY]?.server,
        },
    };

    // If we've been asked to run, but no port was given,
    // we'll use the default port, so warn the user.
    if (validatedOptions.server.run && !askedPort) {
        log.info(
            `Synthetics local server port is not set, you can use either :
  - ${chalk.bold.yellow('export BUILD_PLUGINS_S8S_PORT=1234')} before running your build.
  - ${chalk.bold.yellow('config.synthetics.server.port: 1234')} in your configuration.

Server will still run with the default port ${chalk.bold.cyan(DEFAULT_PORT.toString())}.
`,
        );
    }

    return validatedOptions;
};
