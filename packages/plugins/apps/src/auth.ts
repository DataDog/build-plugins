// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDDEnvValue } from '@dd/core/helpers/env';
import { doRequest } from '@dd/core/helpers/request';
import type { RequestOpts } from '@dd/core/types';

export const AUTH_GUIDANCE =
    'Set DD_API_KEY and DD_APP_KEY for API-key auth, or set DD_OAUTH_ACCESS_TOKEN ' +
    '(or DATADOG_OAUTH_ACCESS_TOKEN) — e.g. by starting the dev server with `datadog-apps dev`.';

export type DoAuthenticatedRequest = <T>(opts: Omit<RequestOpts, 'auth'>) => Promise<T>;

export class MissingAuthenticationError extends Error {
    public statusCode = 400;

    constructor() {
        super(`Missing authentication. ${AUTH_GUIDANCE}`);
        this.name = 'MissingAuthenticationError';
    }
}

// Build the dev-server request authenticator. API-key auth (DD_API_KEY +
// DD_APP_KEY) takes precedence; otherwise the OAuth access token that
// @datadog/apps-cli passes via DD_OAUTH_ACCESS_TOKEN is used.
export const getAuthenticatedRequest = (): DoAuthenticatedRequest => {
    const apiKey = getDDEnvValue('API_KEY');
    const appKey = getDDEnvValue('APP_KEY');
    if (apiKey && appKey) {
        return (opts) =>
            doRequest({
                ...opts,
                auth: {
                    apiKey,
                    appKey,
                },
            });
    }

    const accessToken = getDDEnvValue('OAUTH_ACCESS_TOKEN');
    if (accessToken) {
        return (opts) =>
            doRequest({
                ...opts,
                auth: {
                    accessToken,
                },
            });
    }

    throw new MissingAuthenticationError();
};
