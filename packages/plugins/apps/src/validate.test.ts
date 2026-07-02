// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { validateOptions } from '@dd/apps-plugin/validate';
import { cleanEnv } from '@dd/tests/_jest/helpers/env';

describe('Apps Plugin - validateOptions', () => {
    let restoreEnv: () => void;

    beforeEach(() => {
        restoreEnv = cleanEnv();
    });

    afterEach(() => {
        restoreEnv();
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

        test('Should set dryRun to false when DD_APPS_UPLOAD_ASSETS=true', () => {
            process.env.DD_APPS_UPLOAD_ASSETS = 'true';
            const result = validateOptions({ apps: {} });
            expect(result.dryRun).toBe(false);
        });

        test('Should keep dryRun true when DD_APPS_UPLOAD_ASSETS=false (not just any string)', () => {
            process.env.DD_APPS_UPLOAD_ASSETS = 'false';
            const result = validateOptions({ apps: {} });
            expect(result.dryRun).toBe(true);
        });

        test('Should keep dryRun true when DD_APPS_UPLOAD_ASSETS=0', () => {
            process.env.DD_APPS_UPLOAD_ASSETS = '0';
            const result = validateOptions({ apps: {} });
            expect(result.dryRun).toBe(true);
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

describe('new app properties', () => {
    test('Should pass description through to resolved options', () => {
        const result = validateOptions({ apps: { description: 'My app description' } });
        expect(result.description).toBe('My app description');
    });

    test('Should pass selfService true through to resolved options', () => {
        const result = validateOptions({ apps: { selfService: true } });
        expect(result.selfService).toBe(true);
    });

    test('Should pass selfService false through to resolved options', () => {
        const result = validateOptions({ apps: { selfService: false } });
        expect(result.selfService).toBe(false);
    });

    test('Should pass permissions through to resolved options', () => {
        const result = validateOptions({
            apps: {
                permissions: {
                    protectionLevel: 'approval_required',
                    runAs: '550e8400-e29b-41d4-a716-446655440000',
                },
            },
        });
        expect(result.permissions).toEqual({
            protectionLevel: 'approval_required',
            runAs: '550e8400-e29b-41d4-a716-446655440000',
        });
    });

    test('Should omit description, selfService, and permissions entirely when not configured', () => {
        const result = validateOptions({ apps: {} });
        // Keys must be absent (not merely undefined) so callers that use
        // hasOwnProperty / 'in' checks and the manifest builder's != null
        // guard both behave correctly when no value was provided.
        expect(result).not.toHaveProperty('description');
        expect(result).not.toHaveProperty('selfService');
        expect(result).not.toHaveProperty('permissions');
    });
});
