// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { DEFAULT_SITE } from '@dd/core/constants';
import { getDDEnvValue } from '@dd/core/helpers/env';
import type { AuthMethod, Options } from '@dd/core/types';

import { CONFIG_KEY } from './constants';
import { getOAuthConfig } from './oauth';
import type { AppsOptions, AppsOptionsWithDefaults } from './types';

const AUTH_METHODS: AuthMethod[] = ['apiKey', 'oauth'];

const resolveAuthMethod = (value: string | undefined): AuthMethod | undefined => {
    if (value === undefined) {
        return undefined;
    }

    if (AUTH_METHODS.includes(value as AuthMethod)) {
        return value as AuthMethod;
    }

    throw new Error(`auth.method must be one of: ${AUTH_METHODS.join(', ')}`);
};

export const validateOptions = (options: Options): AppsOptionsWithDefaults => {
    const resolvedOptions = (options[CONFIG_KEY] || {}) as AppsOptions;
    const method =
        resolveAuthMethod(getDDEnvValue('AUTH_METHOD')) ||
        resolveAuthMethod(options.auth?.method) ||
        'apiKey';
    const site = options.auth?.site || DEFAULT_SITE;

    return {
        method,
        include: resolvedOptions.include || [],
        dryRun: resolvedOptions.dryRun ?? !getDDEnvValue('APPS_UPLOAD_ASSETS'),
        identifier: resolvedOptions.identifier?.trim(),
        name: resolvedOptions.name?.trim() || options.metadata?.name?.trim(),
        oauth: getOAuthConfig(site),
    };
};
