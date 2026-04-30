// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDDEnvValue } from '@dd/core/helpers/env';
import { resolveEnable } from '@dd/core/helpers/options';
import type { Logger, Options } from '@dd/core/types';

import { CONFIG_KEY } from './constants';
import type { AppsOptions, AppsOptionsWithDefaults } from './types';

export const validateOptions = (options: Options, log: Logger): AppsOptionsWithDefaults => {
    const resolvedOptions = (options[CONFIG_KEY] || {}) as AppsOptions;

    const validatedOptions: AppsOptionsWithDefaults = {
        enable: resolveEnable(options, CONFIG_KEY, log),
        include: resolvedOptions.include || [],
        dryRun: resolvedOptions.dryRun ?? !getDDEnvValue('APPS_UPLOAD_ASSETS'),
        identifier: resolvedOptions.identifier?.trim(),
        name: resolvedOptions.name?.trim() || options.metadata?.name?.trim(),
    };

    return validatedOptions;
};
