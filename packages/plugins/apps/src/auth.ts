// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import { getDDEnvValue } from '@dd/core/helpers/env';
import { doRequest } from '@dd/core/helpers/request';
import type { RequestOpts } from '@dd/core/types';

export const AUTH_GUIDANCE =
    'Set DD_API_KEY and DD_APP_KEY for API-key auth, or set DD_OAUTH_ACCESS_TOKEN ' +
    '(or DATADOG_OAUTH_ACCESS_TOKEN) — e.g. by starting the dev server with `datadog-apps dev`.';

// Pinned when the first authenticated request is created, before any backend function runs, and kept on
// globalThis across restarts, which can load a fresh copy of this module, so a dependency that later
// replaces the global never sees or breaks these requests.
const PINNED_FETCH_KEY = Symbol.for('@datadog/vite-plugin/apps/pinned-fetch');

function isFetch(value: unknown): value is typeof fetch {
    return typeof value === 'function';
}

function getPinnedFetch(): typeof fetch {
    const pinned: unknown = Reflect.get(globalThis, PINNED_FETCH_KEY);
    if (isFetch(pinned)) {
        return pinned;
    }
    const current = globalThis.fetch;
    Reflect.set(globalThis, PINNED_FETCH_KEY, current);
    return current;
}

export type DoAuthenticatedRequest = <T>(opts: Omit<RequestOpts, 'auth'>) => Promise<T>;

export class MissingAuthenticationError extends Error {
    public statusCode = 400;

    constructor() {
        super(`Missing authentication. ${AUTH_GUIDANCE}`);
        this.name = 'MissingAuthenticationError';
    }
}

export type AuthCredentials = { apiKey: string; appKey: string } | { accessToken: string };

// API-key auth (DD_API_KEY + DD_APP_KEY) wins, else the OAuth token @datadog/apps-cli passes via
// DD_OAUTH_ACCESS_TOKEN. Accepted risk: either stays in process.env for the session (no process
// separation, like other local dev tools), readable by a backend function's dependencies.
export const getAuthCredentials = (): AuthCredentials | undefined => {
    const apiKey = getDDEnvValue('API_KEY');
    const appKey = getDDEnvValue('APP_KEY');
    if (apiKey && appKey) {
        return { apiKey, appKey };
    }

    const accessToken = getDDEnvValue('OAUTH_ACCESS_TOKEN');
    if (accessToken) {
        return { accessToken };
    }

    return undefined;
};

export const createAuthenticatedRequest = (auth: AuthCredentials): DoAuthenticatedRequest => {
    const fetchImpl = getPinnedFetch();
    return async (opts) => doRequest({ ...opts, auth, fetchImpl });
};

export const getAuthenticatedRequest = (): DoAuthenticatedRequest => {
    const auth = getAuthCredentials();
    if (!auth) {
        throw new MissingAuthenticationError();
    }
    return createAuthenticatedRequest(auth);
};
