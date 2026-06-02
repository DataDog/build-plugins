// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    DEFAULT_APPS_OAUTH_CLIENT_ID,
    DEFAULT_APPS_OAUTH_REDIRECT_URI,
    DEFAULT_APPS_OAUTH_TIMEOUT_MS,
} from '@dd/apps-plugin/oauth';
import { validateOptions } from '@dd/apps-plugin/validate';

const defaultOAuthOptions = {
    authorizationUrl: undefined,
    cacheTokens: true,
    clientId: DEFAULT_APPS_OAUTH_CLIENT_ID,
    openBrowser: true,
    redirectUri: DEFAULT_APPS_OAUTH_REDIRECT_URI,
    timeoutMs: DEFAULT_APPS_OAUTH_TIMEOUT_MS,
    tokenUrl: undefined,
};

describe('Apps Plugin - validateOptions', () => {
    describe('defaults', () => {
        test('Should set defaults when nothing is provided', () => {
            const result = validateOptions({});
            expect(result).toEqual({
                dryRun: true,
                include: [],
                identifier: undefined,
                method: 'apiKey',
                name: undefined,
                oauth: defaultOAuthOptions,
            });
        });

        test('Should set dryRun to false when DATADOG_APPS_UPLOAD_ASSETS is set', () => {
            process.env.DATADOG_APPS_UPLOAD_ASSETS = '1';
            try {
                const result = validateOptions({ apps: {} });
                expect(result.dryRun).toBe(false);
            } finally {
                delete process.env.DATADOG_APPS_UPLOAD_ASSETS;
            }
        });

        test('Should set dryRun to false when DD_APPS_UPLOAD_ASSETS is set', () => {
            process.env.DD_APPS_UPLOAD_ASSETS = '1';
            try {
                const result = validateOptions({ apps: {} });
                expect(result.dryRun).toBe(false);
            } finally {
                delete process.env.DD_APPS_UPLOAD_ASSETS;
            }
        });

        test('Should respect explicit dryRun over env var', () => {
            process.env.DATADOG_APPS_UPLOAD_ASSETS = '1';
            try {
                const result = validateOptions({ apps: { dryRun: true } });
                expect(result.dryRun).toBe(true);
            } finally {
                delete process.env.DATADOG_APPS_UPLOAD_ASSETS;
            }
        });
    });

    describe('overrides', () => {
        test('Should keep provided options and trim identifier', () => {
            const result = validateOptions({
                apps: {
                    dryRun: true,
                    enable: true,
                    include: ['public/**/*', 'dist/**/*'],
                    identifier: '  my-app  ',
                },
            });

            expect(result).toEqual({
                dryRun: true,
                include: ['public/**/*', 'dist/**/*'],
                identifier: 'my-app',
                method: 'apiKey',
                name: undefined,
                oauth: defaultOAuthOptions,
            });
        });

        test('Should enable OAuth method when configured', () => {
            const result = validateOptions({
                auth: {
                    method: 'oauth',
                    oauthOptions: {
                        clientId: 'custom-client',
                        cacheTokens: false,
                        openBrowser: false,
                        redirectUri: 'http://localhost:9000/callback',
                        timeoutMs: 1000,
                    },
                },
                apps: {
                    enable: true,
                },
            });

            expect(result.method).toBe('oauth');
            expect(result.oauth).toEqual({
                ...defaultOAuthOptions,
                cacheTokens: false,
                clientId: 'custom-client',
                openBrowser: false,
                redirectUri: 'http://localhost:9000/callback',
                timeoutMs: 1000,
            });
        });

        test('Should keep API key method when only OAuth options are provided', () => {
            const result = validateOptions({
                auth: {
                    oauthOptions: {
                        clientId: 'custom-client',
                    },
                },
                apps: {
                    enable: true,
                },
            });

            expect(result.method).toBe('apiKey');
            expect(result.oauth.clientId).toBe('custom-client');
        });

        test('Should allow env vars to opt into OAuth and override public client settings', () => {
            process.env.DATADOG_AUTH_METHOD = 'oauth';
            process.env.DATADOG_OAUTH_CLIENT_ID = 'env-client';
            process.env.DATADOG_OAUTH_REDIRECT_URI = 'http://localhost:8061/callback';
            try {
                const result = validateOptions({ apps: {} });
                expect(result.method).toBe('oauth');
                expect(result.oauth.clientId).toBe('env-client');
                expect(result.oauth.redirectUri).toBe('http://localhost:8061/callback');
            } finally {
                delete process.env.DATADOG_AUTH_METHOD;
                delete process.env.DATADOG_OAUTH_CLIENT_ID;
                delete process.env.DATADOG_OAUTH_REDIRECT_URI;
            }
        });
    });
});
