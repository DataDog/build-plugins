// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { validateOptions } from '@dd/apps-plugin/validate';

const authEnvVars = [
    'DATADOG_API_KEY',
    'DD_API_KEY',
    'DATADOG_APP_KEY',
    'DD_APP_KEY',
    'DATADOG_APPS_AUTH_METHOD',
    'DD_APPS_AUTH_METHOD',
] as const;

const savedAuthEnv = Object.fromEntries(
    authEnvVars.map((key) => [key, process.env[key]]),
) as Record<(typeof authEnvVars)[number], string | undefined>;

const restoreAuthEnv = () => {
    for (const key of authEnvVars) {
        const value = savedAuthEnv[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
};

describe('Apps Plugin - validateOptions', () => {
    beforeEach(() => {
        for (const key of authEnvVars) {
            delete process.env[key];
        }
    });

    afterEach(() => {
        restoreAuthEnv();
    });

    describe('defaults', () => {
        test('Should default to OAuth when API/App keys are not provided', () => {
            const result = validateOptions({});
            expect(result).toEqual({
                authOverrides: {
                    method: 'oauth',
                },
                dryRun: true,
                include: [],
                identifier: undefined,
                name: undefined,
            });
        });

        test('Should default to API-key auth when API/App keys are configured', () => {
            const result = validateOptions({
                auth: {
                    apiKey: 'api-key',
                    appKey: 'app-key',
                },
            });

            expect(result.authOverrides.method).toBe('apiKey');
        });

        test('Should default to API-key auth when API/App keys are configured through env vars', () => {
            process.env.DATADOG_API_KEY = 'api-key';
            process.env.DATADOG_APP_KEY = 'app-key';

            const result = validateOptions({});
            expect(result.authOverrides.method).toBe('apiKey');
        });

        test('Should default to OAuth when API-key auth is incomplete', () => {
            const result = validateOptions({
                auth: {
                    apiKey: 'api-key',
                },
            });

            expect(result.authOverrides.method).toBe('oauth');
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
                authOverrides: {
                    method: 'oauth',
                },
                dryRun: true,
                include: ['public/**/*', 'dist/**/*'],
                identifier: 'my-app',
                name: undefined,
            });
        });

        test('Should enable OAuth method when configured', () => {
            const result = validateOptions({
                apps: {
                    enable: true,
                    authOverrides: { method: 'oauth' },
                },
            });

            expect(result.authOverrides.method).toBe('oauth');
        });

        test('Should prefer configured OAuth over available API/App keys', () => {
            const result = validateOptions({
                auth: {
                    apiKey: 'api-key',
                    appKey: 'app-key',
                },
                apps: {
                    enable: true,
                    authOverrides: { method: 'oauth' },
                },
            });

            expect(result.authOverrides.method).toBe('oauth');
        });

        test('Should enable API-key method when configured', () => {
            const result = validateOptions({
                apps: {
                    enable: true,
                    authOverrides: { method: 'apiKey' },
                },
            });

            expect(result.authOverrides.method).toBe('apiKey');
        });

        test('Should allow env vars to opt into OAuth', () => {
            process.env.DATADOG_APPS_AUTH_METHOD = 'oauth';

            const result = validateOptions({ apps: {} });
            expect(result.authOverrides.method).toBe('oauth');
        });

        test('Should allow env vars to opt into API-key auth', () => {
            process.env.DATADOG_APPS_AUTH_METHOD = 'apiKey';

            const result = validateOptions({ apps: {} });
            expect(result.authOverrides.method).toBe('apiKey');
        });
    });
});
