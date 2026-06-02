// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    DATAD0G_APPS_OAUTH_CLIENT_ID,
    DEFAULT_APPS_OAUTH_CLIENT_ID,
    DEFAULT_APPS_OAUTH_REDIRECT_URI,
    DEFAULT_APPS_OAUTH_TIMEOUT_MS,
    getOAuthConfig,
} from '@dd/apps-plugin/oauth';
import { validateOptions } from '@dd/apps-plugin/validate';
import { DEFAULT_SITE } from '@dd/core/constants';

const defaultOAuthConfig = getOAuthConfig(DEFAULT_SITE);

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
                oauth: defaultOAuthConfig,
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
                oauth: defaultOAuthConfig,
            });
        });

        test('Should enable OAuth method when configured', () => {
            const result = validateOptions({
                auth: {
                    method: 'oauth',
                },
                apps: {
                    enable: true,
                },
            });

            expect(result.method).toBe('oauth');
            expect(result.oauth).toEqual(defaultOAuthConfig);
        });

        test('Should derive OAuth endpoints and default client ID from the configured site', () => {
            const result = validateOptions({
                auth: {
                    site: 'datadoghq.eu',
                },
                apps: {
                    enable: true,
                },
            });

            expect(result.oauth).toEqual({
                authorizationUrl: 'https://api.datadoghq.eu/oauth2/v1/authorize',
                cacheTokens: true,
                clientId: DEFAULT_APPS_OAUTH_CLIENT_ID,
                openBrowser: true,
                redirectUri: DEFAULT_APPS_OAUTH_REDIRECT_URI,
                timeoutMs: DEFAULT_APPS_OAUTH_TIMEOUT_MS,
                tokenUrl: 'https://api.datadoghq.eu/oauth2/v1/token',
            });
        });

        test('Should use the datad0g OAuth client ID for datad0g.com', () => {
            const result = validateOptions({
                auth: {
                    site: 'datad0g.com',
                },
                apps: {
                    enable: true,
                },
            });

            expect(result.oauth.clientId).toBe(DATAD0G_APPS_OAUTH_CLIENT_ID);
            expect(result.oauth.authorizationUrl).toBe(
                'https://api.datad0g.com/oauth2/v1/authorize',
            );
            expect(result.oauth.tokenUrl).toBe('https://api.datad0g.com/oauth2/v1/token');
        });

        test('Should allow env vars to opt into OAuth', () => {
            process.env.DATADOG_AUTH_METHOD = 'oauth';
            try {
                const result = validateOptions({ apps: {} });
                expect(result.method).toBe('oauth');
                expect(result.oauth).toEqual(defaultOAuthConfig);
            } finally {
                delete process.env.DATADOG_AUTH_METHOD;
            }
        });
    });
});
