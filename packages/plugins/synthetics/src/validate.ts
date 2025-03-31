// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options, Logger } from '@dd/core/types';

import { CONFIG_KEY } from './constants';
import type { SyntheticsOptionsWithDefaults } from './types';

export const validateOptions = (config: Options, log: Logger): SyntheticsOptionsWithDefaults => {
    // Get values from environment.
    const { BUILD_PLUGINS_S8S_PORT } = process.env;

    // Define defaults.
    const validatedOptions: SyntheticsOptionsWithDefaults = {
        // We don't want to disable it by default.
        disabled: false,
        ...config[CONFIG_KEY],
    };

    if (BUILD_PLUGINS_S8S_PORT) {
        validatedOptions.server = {
            run: true,
            port: +BUILD_PLUGINS_S8S_PORT,
        };
    }

    return validatedOptions;
};
