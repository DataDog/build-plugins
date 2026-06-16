// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doOAuthRequest, doRequest } from '@dd/core/helpers/request';
import type { AuthOptionsWithDefaults, Logger, RequestOpts } from '@dd/core/types';

import type { AuthMethod } from './types';

export type DoAuthenticatedRequest = <T>(opts: Omit<RequestOpts, 'auth'>) => Promise<T>;

// Build the authenticated request function from the resolved method + base credentials.
// Returns undefined when API-key auth is selected but credentials are missing.
export const getAuthenticatedRequest = (
    method: AuthMethod,
    auth: AuthOptionsWithDefaults,
    log: Logger,
): DoAuthenticatedRequest | undefined => {
    if (method === 'oauth') {
        return (opts) => doOAuthRequest({ ...opts, site: auth.site, log });
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

    return undefined;
};
