// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    AuthMethod,
    AuthOptionsWithDefaults,
    Logger,
    RequestAuthOptions,
    RequestOpts,
} from '../types';

import { getOAuthConfig, getOAuthToken } from './oauth';

export type RequestOptsWithoutAuth = Omit<RequestOpts, 'auth'>;
export type RequestFunction = <T>(opts: RequestOpts) => Promise<T>;
export type AuthenticatedRequestFunction = (<T>(opts: RequestOptsWithoutAuth) => Promise<T>) & {
    assertAuthConfigured: () => void;
};

export const DEFAULT_API_AUTH_MISSING_AUTH_MESSAGE =
    'Auth credentials not configured. Set DD_API_KEY and DD_APP_KEY.';
export const DEFAULT_OAUTH_AUTH_MISSING_AUTH_MESSAGE =
    'OAuth auth is not configured. Set a Datadog site before authorizing OAuth requests.';
export const DEFAULT_OAUTH_AND_API_AUTH_MISSING_AUTH_MESSAGE =
    'Auth credentials not configured. Set DD_API_KEY and DD_APP_KEY or use OAuth auth.';

export class MissingRequestAuthError extends Error {
    constructor(message = DEFAULT_API_AUTH_MISSING_AUTH_MESSAGE) {
        super(message);
    }
}

export const authMethodIsOauth = (method?: AuthMethod) => method === 'oauth';

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

export const withOAuthAuth =
    ({
        auth,
        log,
        missingAuthMessage = DEFAULT_OAUTH_AUTH_MISSING_AUTH_MESSAGE,
    }: {
        auth: Pick<AuthOptionsWithDefaults, 'site'>;
        log: Logger;
        missingAuthMessage?: string;
    }) =>
    (request: RequestFunction): AuthenticatedRequestFunction => {
        let oauthRequestAuthPromise: Promise<RequestAuthOptions> | undefined;

        if (!auth.site) {
            log.warn(missingAuthMessage);
        }

        const assertAuthConfigured = () => {
            if (!auth.site) {
                throw new MissingRequestAuthError(missingAuthMessage);
            }
        };

        const authorizeOAuthRequest = async (): Promise<RequestAuthOptions> => {
            assertAuthConfigured();
            const authTimer = log.time('authorize OAuth request');
            try {
                const token = await getOAuthToken(auth.site, getOAuthConfig(auth.site), log);
                return { type: 'bearer', accessToken: token.accessToken };
            } finally {
                authTimer.end();
            }
        };

        const requestWithAuth = async <T>(opts: RequestOptsWithoutAuth) => {
            try {
                assertAuthConfigured();
                if (!oauthRequestAuthPromise) {
                    oauthRequestAuthPromise = authorizeOAuthRequest();
                }
                const requestAuth = await oauthRequestAuthPromise;
                return request<T>({ ...opts, auth: requestAuth });
            } finally {
                oauthRequestAuthPromise = undefined;
            }
        };

        requestWithAuth.assertAuthConfigured = assertAuthConfigured;
        return requestWithAuth;
    };

export const withOAuthAndApiAuth =
    ({
        auth,
        log,
        method,
        missingAuthMessage = DEFAULT_OAUTH_AND_API_AUTH_MISSING_AUTH_MESSAGE,
    }: {
        auth: AuthOptionsWithDefaults;
        log: Logger;
        method: AuthMethod;
        missingAuthMessage?: string;
    }) =>
    (request: RequestFunction): AuthenticatedRequestFunction =>
        authMethodIsOauth(method)
            ? withOAuthAuth({ auth, log, missingAuthMessage })(request)
            : withApiAuth({ auth, log, missingAuthMessage })(request);
