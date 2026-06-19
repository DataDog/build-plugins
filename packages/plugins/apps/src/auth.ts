// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doOAuthRequest } from '@dd/core/helpers/oauth-request';
import { doRequest } from '@dd/core/helpers/request';
import type { AuthOptionsWithDefaults, Logger, RequestOpts } from '@dd/core/types';

import type { AuthMethod } from './types';

export const AUTH_GUIDANCE =
    'Set apps.authOverrides.method: "oauth" or DD_APPS_AUTH_METHOD=oauth to use OAuth, ' +
    'or set DD_API_KEY and DD_APP_KEY to use API/App key auth.';

export type DoAuthenticatedRequest = <T>(opts: Omit<RequestOpts, 'auth'>) => Promise<T>;

export class MissingAuthenticationError extends Error {
    public statusCode = 400;

    constructor() {
        super(`Missing authentication. ${AUTH_GUIDANCE}`);
        this.name = 'MissingAuthenticationError';
    }
}

// Build the authenticated request function from the resolved method + base credentials.
export const getAuthenticatedRequest = (
    method: AuthMethod,
    auth: AuthOptionsWithDefaults,
    log: Logger,
): DoAuthenticatedRequest => {
    if (method === 'oauth') {
        return (opts) => doOAuthRequest({ ...opts, auth, log });
    }

    if (auth.apiKey && auth.appKey) {
        return (opts) =>
            doRequest({
                ...opts,
                auth: {
                    apiKey: auth.apiKey,
                    appKey: auth.appKey,
                },
            });
    }

    throw new MissingAuthenticationError();
};
