// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { cleanEnv } from '@dd/tests/_jest/helpers/env';

import { validateOptions } from './validate';

describe('Apps Plugin - validateOptions', () => {
    let restoreEnv: () => void;

    beforeEach(() => {
        restoreEnv = cleanEnv();
    });

    afterEach(() => {
        restoreEnv();
    });

    test('uses package-only defaults and OAuth when credentials are absent', () => {
        expect(validateOptions({ apps: {} })).toEqual({
            include: [],
            authOverrides: { method: 'oauth' },
            longPolling: {
                maxRetries: 10,
                timeoutMs: 40000,
                jitter: true,
                exponentialBackoff: true,
            },
        });
    });

    test('uses API-key auth when both keys are configured via auth option', () => {
        const result = validateOptions({
            auth: { apiKey: 'api-key', appKey: 'app-key' },
        });
        expect(result.authOverrides.method).toBe('apiKey');
    });

    test('uses API-key auth only when both keys are available', () => {
        process.env.DATADOG_API_KEY = 'api-key';
        process.env.DATADOG_APP_KEY = 'app-key';

        expect(validateOptions({ apps: {} }).authOverrides.method).toBe('apiKey');
    });

    test('defaults to OAuth when API-key auth is incomplete', () => {
        const result = validateOptions({
            auth: { apiKey: 'api-key' },
        });
        expect(result.authOverrides.method).toBe('oauth');
    });

    test('respects explicit OAuth method over available API/App keys', () => {
        const result = validateOptions({
            auth: { apiKey: 'api-key', appKey: 'app-key' },
            apps: { authOverrides: { method: 'oauth' } },
        });
        expect(result.authOverrides.method).toBe('oauth');
    });

    test('respects explicit apiKey method when no keys are configured', () => {
        const result = validateOptions({
            apps: { authOverrides: { method: 'apiKey' } },
        });
        expect(result.authOverrides.method).toBe('apiKey');
    });

    test('allows env var to override auth method to OAuth', () => {
        process.env.DATADOG_APPS_AUTH_METHOD = 'oauth';

        expect(validateOptions({ apps: {} }).authOverrides.method).toBe('oauth');
    });

    test('allows env var to override auth method to apiKey', () => {
        process.env.DATADOG_APPS_AUTH_METHOD = 'apiKey';

        expect(validateOptions({ apps: {} }).authOverrides.method).toBe('apiKey');
    });

    test('throws on invalid auth method', () => {
        expect(() =>
            validateOptions({ apps: { authOverrides: { method: 'invalid' as never } } }),
        ).toThrow('apps.authOverrides.method must be one of: apiKey, oauth');
    });

    test('passes description through to resolved options', () => {
        expect(validateOptions({ apps: { description: 'My app description' } }).description).toBe(
            'My app description',
        );
    });

    test('passes selfService true through to resolved options', () => {
        expect(validateOptions({ apps: { selfService: true } }).selfService).toBe(true);
    });

    test('passes selfService false through to resolved options', () => {
        expect(validateOptions({ apps: { selfService: false } }).selfService).toBe(false);
    });

    test('passes permissions through to resolved options', () => {
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

    test('omits description, selfService, and permissions entirely when not configured', () => {
        const result = validateOptions({ apps: {} });
        expect(result).not.toHaveProperty('description');
        expect(result).not.toHaveProperty('selfService');
        expect(result).not.toHaveProperty('permissions');
    });

    describe('longPolling', () => {
        test('Should default maxRetries, jitter and exponentialBackoff', () => {
            const result = validateOptions({ apps: {} });
            expect(result.longPolling).toEqual({
                maxRetries: 10,
                timeoutMs: 40000,
                jitter: true,
                exponentialBackoff: true,
            });
        });

        test('Should allow disabling retries by setting maxRetries to 1', () => {
            const result = validateOptions({ apps: { longPolling: { maxRetries: 1 } } });
            expect(result.longPolling.maxRetries).toBe(1);
        });

        test('Should allow disabling jitter and exponentialBackoff', () => {
            const result = validateOptions({
                apps: { longPolling: { jitter: false, exponentialBackoff: false } },
            });
            expect(result.longPolling.jitter).toBe(false);
            expect(result.longPolling.exponentialBackoff).toBe(false);
        });

        test('Should allow overriding timeoutMs', () => {
            const result = validateOptions({ apps: { longPolling: { timeoutMs: 60_000 } } });
            expect(result.longPolling.timeoutMs).toBe(60_000);
        });

        test('Should throw when timeoutMs is not a positive number', () => {
            expect(() => validateOptions({ apps: { longPolling: { timeoutMs: 0 } } })).toThrow(
                'apps.longPolling.timeoutMs must be a positive number.',
            );
            expect(() => validateOptions({ apps: { longPolling: { timeoutMs: -1 } } })).toThrow(
                'apps.longPolling.timeoutMs must be a positive number.',
            );
        });

        test('Should throw when maxRetries is not a positive integer', () => {
            expect(() => validateOptions({ apps: { longPolling: { maxRetries: 0 } } })).toThrow(
                'apps.longPolling.maxRetries must be an integer >= 1.',
            );
            expect(() => validateOptions({ apps: { longPolling: { maxRetries: 1.5 } } })).toThrow(
                'apps.longPolling.maxRetries must be an integer >= 1.',
            );
        });
    });
});
