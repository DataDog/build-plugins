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
            identifier: undefined,
            name: undefined,
            authOverrides: { method: 'oauth' },
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

    test('uses environment identity overrides before plugin configuration', () => {
        process.env.DATADOG_APPS_IDENTIFIER = 'command-id';
        process.env.DATADOG_APPS_NAME = 'Command Name';

        expect(
            validateOptions({
                apps: { identifier: 'config-id', name: 'Config Name' },
                metadata: { name: 'Metadata Name' },
            }),
        ).toMatchObject({ identifier: 'command-id', name: 'Command Name' });
    });

    test('trims identifier and falls back to metadata name', () => {
        const result = validateOptions({
            apps: { identifier: '  my-app  ' },
            metadata: { name: 'Metadata Name' },
        });
        expect(result.identifier).toBe('my-app');
        expect(result.name).toBe('Metadata Name');
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
});
