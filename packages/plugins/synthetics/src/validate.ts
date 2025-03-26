import type { Options, Logger, GlobalContext } from '@dd/core/types';
import { CONFIG_KEY, DEFAULT_PORT } from '@dd/synthetics-plugin/constants';
import type { SyntheticsOptionsWithDefaults } from '@dd/synthetics-plugin/types';
import chalk from 'chalk';

export const validateOptions = (
    config: Options,
    context: GlobalContext,
    log: Logger,
): SyntheticsOptionsWithDefaults => {
    const validatedOptions: SyntheticsOptionsWithDefaults = {
        // We don't want to disable it by default.
        disabled: false,
        ...config[CONFIG_KEY],
        server: {
            run: false,
            port: DEFAULT_PORT,
            root: context.bundler.outDir,
            ...config[CONFIG_KEY]?.server,
        },
    };

    const { BUILD_PLUGINS_S8S_LOCAL, BUILD_PLUGINS_S8S_PORT } = process.env;

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

    validatedOptions.server.run =
        !validatedOptions.disabled && BUILD_PLUGINS_S8S_LOCAL === '1' && !!BUILD_PLUGINS_S8S_PORT;

    if (BUILD_PLUGINS_S8S_PORT) {
        validatedOptions.server.port = +BUILD_PLUGINS_S8S_PORT;
    }

    return validatedOptions;
};
