// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, Options } from '@dd/core/types';

import { CONFIG_KEY, defaultPluginOptions } from './constants';
import type { RumPrivacyOptions } from './types';

export const validateOptions = (options: Options, log: Logger): RumPrivacyOptions => {
    log.info(`Validating options: ${JSON.stringify(options)}`);
    return {
        ...defaultPluginOptions,
        ...options[CONFIG_KEY],
    };
};
