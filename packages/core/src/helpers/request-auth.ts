// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { AuthOptionsWithDefaults, Logger, RequestAuthOptions, RequestOpts } from '../types';

export type RequestOptsWithoutAuth = Omit<RequestOpts, 'auth'>;
export type RequestFunction = <T>(opts: RequestOpts) => Promise<T>;
export type AuthenticatedRequestFunction = (<T>(opts: RequestOptsWithoutAuth) => Promise<T>) & {
    assertAuthConfigured: () => void;
};

export const DEFAULT_API_AUTH_MISSING_AUTH_MESSAGE =
    'Auth credentials not configured. Set DD_API_KEY and DD_APP_KEY.';

export class MissingRequestAuthError extends Error {
    constructor(message = DEFAULT_API_AUTH_MISSING_AUTH_MESSAGE) {
        super(message);
    }
}

export const hasValidAppApiKey = (auth: Pick<AuthOptionsWithDefaults, 'apiKey' | 'appKey'>) =>
    Boolean(auth.apiKey && auth.appKey);

const isAbsoluteUrl = (url: string) => /^https?:\/\//.test(url);

export const withBaseUrl =
    (baseUrl: string) =>
    (request: RequestFunction): RequestFunction =>
    async <T>(opts: RequestOpts) => {
        const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
        const url = isAbsoluteUrl(opts.url)
            ? opts.url
            : `${normalizedBaseUrl}${opts.url.startsWith('/') ? '' : '/'}${opts.url}`;

        return request<T>({ ...opts, url });
    };

export const withApiAuth =
    ({
        auth,
        log,
        missingAuthMessage = DEFAULT_API_AUTH_MISSING_AUTH_MESSAGE,
    }: {
        auth: Pick<AuthOptionsWithDefaults, 'apiKey' | 'appKey'>;
        log?: Pick<Logger, 'warn'>;
        missingAuthMessage?: string;
    }) =>
    (request: RequestFunction): AuthenticatedRequestFunction => {
        const requestAuth: RequestAuthOptions | undefined = hasValidAppApiKey(auth)
            ? { apiKey: auth.apiKey, appKey: auth.appKey }
            : undefined;
        let didWarn = false;

        const assertAuthConfigured = () => {
            if (!requestAuth) {
                if (!didWarn) {
                    log?.warn(missingAuthMessage);
                    didWarn = true;
                }
                throw new MissingRequestAuthError(missingAuthMessage);
            }
        };

        const requestWithAuth = async <T>(opts: RequestOptsWithoutAuth) => {
            assertAuthConfigured();

            return request<T>({
                ...opts,
                auth: requestAuth,
            });
        };

        requestWithAuth.assertAuthConfigured = assertAuthConfigured;
        return requestWithAuth;
    };
