// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDDEnvValue } from '@dd/core/helpers/env';
import { doRequest } from '@dd/core/helpers/request';
import type { RequestOpts } from '@dd/core/types';

// Lazy, same reasoning as local-execution.ts's getNetworkGuard(): importing network-guard.ts
// installs its monkeypatches at module-load time, and this module is only ever used by the Vite
// dev server (see getAuthenticatedRequest's callers), so deferring the import keeps that install
// confined to Vite instead of triggering for every bundler that transitively imports this file.
let networkGuardModule: Promise<typeof import('./vite/network-guard')> | undefined;
function getNetworkGuard(): Promise<typeof import('./vite/network-guard')> {
    networkGuardModule ??= import('./vite/network-guard').catch((err: unknown) => {
        networkGuardModule = undefined;
        throw err;
    });
    return networkGuardModule;
}

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
        return async (opts) => {
            const { trustedFetch } = await getNetworkGuard();
            return doRequest({
                ...opts,
                auth: {
                    apiKey,
                    appKey,
                },
                fetchImpl: trustedFetch,
            });
        };
    }

    const accessToken = getDDEnvValue('OAUTH_ACCESS_TOKEN');
    if (accessToken) {
        return async (opts) => {
            const { trustedFetch } = await getNetworkGuard();
            return doRequest({
                ...opts,
                auth: {
                    accessToken,
                },
                fetchImpl: trustedFetch,
            });
        };
    }

    throw new MissingAuthenticationError();
};
