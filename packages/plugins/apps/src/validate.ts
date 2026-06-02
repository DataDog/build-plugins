// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDDEnvValue } from '@dd/core/helpers/env';
import type { AuthMethod, Options } from '@dd/core/types';

import { CONFIG_KEY } from './constants';
import {
    DEFAULT_APPS_OAUTH_CLIENT_ID,
    DEFAULT_APPS_OAUTH_REDIRECT_URI,
    DEFAULT_APPS_OAUTH_TIMEOUT_MS,
} from './oauth';
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
    const resolvedOAuthOptions = options.auth?.oauthOptions;
    const method =
        resolveAuthMethod(getDDEnvValue('AUTH_METHOD')) ||
        resolveAuthMethod(options.auth?.method) ||
        'apiKey';

    return {
        method,
        include: resolvedOptions.include || [],
        dryRun: resolvedOptions.dryRun ?? !getDDEnvValue('APPS_UPLOAD_ASSETS'),
        identifier: resolvedOptions.identifier?.trim(),
        name: resolvedOptions.name?.trim() || options.metadata?.name?.trim(),
        oauth: {
            authorizationUrl: resolvedOAuthOptions?.authorizationUrl?.trim(),
            cacheTokens: resolvedOAuthOptions?.cacheTokens ?? true,
            clientId:
                getDDEnvValue('OAUTH_CLIENT_ID') ||
                resolvedOAuthOptions?.clientId?.trim() ||
                DEFAULT_APPS_OAUTH_CLIENT_ID,
            openBrowser: resolvedOAuthOptions?.openBrowser ?? true,
            redirectUri:
                getDDEnvValue('OAUTH_REDIRECT_URI') ||
                resolvedOAuthOptions?.redirectUri?.trim() ||
                DEFAULT_APPS_OAUTH_REDIRECT_URI,
            timeoutMs: resolvedOAuthOptions?.timeoutMs ?? DEFAULT_APPS_OAUTH_TIMEOUT_MS,
            tokenUrl: resolvedOAuthOptions?.tokenUrl?.trim(),
        },
    };
};
