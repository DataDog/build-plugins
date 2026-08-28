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

    test('uses package-only defaults when credentials are absent', () => {
        expect(validateOptions({ apps: {} })).toEqual({
            include: [],
            identifier: undefined,
            name: undefined,
        });
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
