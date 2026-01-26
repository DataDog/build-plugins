// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';

import { CONFIG_KEY } from './constants';
import type { AppsOptions, AppsOptionsWithDefaults } from './types';

export const validateOptions = (options: Options): AppsOptionsWithDefaults => {
    const resolvedOptions = (options[CONFIG_KEY] || {}) as AppsOptions;
    const enable = resolvedOptions.enable ?? !!options[CONFIG_KEY];

    const validatedOptions: AppsOptionsWithDefaults = {
        enable,
        include: resolvedOptions.include || [],
        dryRun: resolvedOptions.dryRun ?? false,
        identifier: resolvedOptions.identifier?.trim(),
        name: resolvedOptions.name?.trim() || options.metadata?.name?.trim(),
    };

    return validatedOptions;
};
