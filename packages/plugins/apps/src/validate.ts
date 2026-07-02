// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDDEnvValue, parseBoolEnv } from '@dd/core/helpers/env';
import type { Options } from '@dd/core/types';

import { CONFIG_KEY } from './constants';
import type { AppsOptions, AppsOptionsWithDefaults, AuthMethod } from './types';

const AUTH_METHODS: AuthMethod[] = ['apiKey', 'oauth'];

const resolveAuthMethod = (value: string | undefined): AuthMethod | undefined => {
    if (value === undefined) {
        return undefined;
    }

    if (AUTH_METHODS.includes(value as AuthMethod)) {
        return value as AuthMethod;
    }

    throw new Error(`apps.authOverrides.method must be one of: ${AUTH_METHODS.join(', ')}`);
};

const hasApiKeyAuth = (options: Options): boolean =>
    Boolean(
        (getDDEnvValue('API_KEY') || options.auth?.apiKey) &&
            (getDDEnvValue('APP_KEY') || options.auth?.appKey),
    );

export const validateOptions = (options: Options): AppsOptionsWithDefaults => {
    const resolvedOptions = (options[CONFIG_KEY] || {}) as AppsOptions;
    const method =
        resolveAuthMethod(
            getDDEnvValue('APPS_AUTH_METHOD') || resolvedOptions.authOverrides?.method,
        ) || (hasApiKeyAuth(options) ? 'apiKey' : 'oauth');

    return {
        include: resolvedOptions.include || [],
        dryRun: resolvedOptions.dryRun ?? !parseBoolEnv(getDDEnvValue('APPS_UPLOAD_ASSETS'), false),
        identifier: resolvedOptions.identifier?.trim(),
        name: resolvedOptions.name?.trim() || options.metadata?.name?.trim(),
        description: resolvedOptions.description,
        selfService: resolvedOptions.selfService,
        permissions: resolvedOptions.permissions,
        authOverrides: {
            method,
        },
    };
};
