// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export type OAuthAuthorizationServer = import('oauth4webapi').AuthorizationServer;
export type OAuthClient = import('oauth4webapi').Client;
export type OAuthModule = typeof import('oauth4webapi');
export type OAuthTokenEndpointResponse = import('oauth4webapi').TokenEndpointResponse;

type KeyringModule = typeof import('@napi-rs/keyring');

const memoizeAsync = <Value>(load: () => Promise<Value>) => {
    let promise: Promise<Value> | undefined;

    return () => {
        if (!promise) {
            promise = load().catch((error) => {
                promise = undefined;
                throw error;
            });
        }
        return promise;
    };
};

export const loadOauth = memoizeAsync(() => import('oauth4webapi') as Promise<OAuthModule>);

// `@napi-rs/keyring` has a CommonJS entry. Load it lazily so API-key uploads
// do not initialize the native credential binding.
export const loadKeyring = memoizeAsync(() => import('@napi-rs/keyring') as Promise<KeyringModule>);
