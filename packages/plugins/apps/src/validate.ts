// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDDEnvValue } from '@dd/core/helpers/env';
import type { Options } from '@dd/core/types';

import { CONFIG_KEY } from './constants';
import type { AppsOptions, AppsOptionsWithDefaults } from './types';

export const validateOptions = (options: Options): AppsOptionsWithDefaults => {
    const resolvedOptions = (options[CONFIG_KEY] || {}) as AppsOptions;

    // Only spread optional app-property fields when explicitly configured — omitting
    // them entirely (rather than setting them to undefined) keeps the returned object
    // shape stable for callers that use hasOwnProperty / 'in' checks. The != null
    // coercion also guards against null values being passed through to the manifest builder.
    return {
        include: resolvedOptions.include || [],
        identifier: getDDEnvValue('APPS_IDENTIFIER')?.trim() || resolvedOptions.identifier?.trim(),
        name:
            getDDEnvValue('APPS_NAME')?.trim() ||
            resolvedOptions.name?.trim() ||
            options.metadata?.name?.trim(),
        ...(resolvedOptions.description != null && { description: resolvedOptions.description }),
        ...(resolvedOptions.selfService != null && { selfService: resolvedOptions.selfService }),
        ...(resolvedOptions.permissions != null && { permissions: resolvedOptions.permissions }),
    };
};
