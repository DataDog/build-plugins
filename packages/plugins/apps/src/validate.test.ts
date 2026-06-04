// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { validateOptions } from '@dd/apps-plugin/validate';

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
            });
        });

        test('Should enable OAuth method when configured', () => {
            const result = validateOptions({
                apps: {
                    authOverride: {
                        method: 'oauth',
                    },
                    enable: true,
                },
            });

            expect(result.method).toBe('oauth');
        });

        test('Should allow env vars to opt into OAuth', () => {
            process.env.DATADOG_APPS_AUTH_METHOD = 'oauth';
            try {
                const result = validateOptions({ apps: {} });
                expect(result.method).toBe('oauth');
            } finally {
                delete process.env.DATADOG_APPS_AUTH_METHOD;
            }
        });
    });
});
