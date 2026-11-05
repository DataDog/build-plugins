// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { clearDatadogEnv } from '@dd/tests/_jest/helpers/datadogEnv';

import { validateOptions } from './validate';

describe('Apps Plugin - validateOptions', () => {
    test('uses package-only defaults', () => {
        expect(validateOptions({ apps: {} })).toEqual({
            include: [],
            tags: undefined,
            longPolling: {
                maxRetries: 10,
                timeoutMs: 40000,
                jitter: true,
                exponentialBackoff: true,
            },
            parameters: undefined,
            excludeSourcemaps: false,
        });
    });

    describe('identity', () => {
        let restoreEnv: () => void;
        beforeEach(() => {
            restoreEnv = clearDatadogEnv();
        });
        afterEach(() => {
            restoreEnv();
        });

        // As read from datadog-app.config.json, which nothing type-checks.
        const nonStringIdentity: { identifier?: string; name?: string } = JSON.parse(
            '{"identifier": 123, "name": {"en": "My App"}}',
        );
        const cases: {
            description: string;
            apps: { identifier?: string; name?: string };
            env?: Record<string, string>;
            expected: { identifier?: string; name?: string };
        }[] = [
            {
                description: 'pass the app identifier and name through, trimmed',
                apps: { identifier: ' 5cf28549-4f3f-432b-9039-bc841ed2b1e1 ', name: ' My App ' },
                expected: { identifier: '5cf28549-4f3f-432b-9039-bc841ed2b1e1', name: 'My App' },
            },
            {
                description: 'leave blank values unset',
                apps: { identifier: '  ', name: '' },
                expected: { identifier: undefined, name: undefined },
            },
            {
                description: 'leave absent values unset',
                apps: {},
                expected: { identifier: undefined, name: undefined },
            },
            {
                description: 'ignore identity values that are not strings',
                apps: nonStringIdentity,
                expected: { identifier: undefined, name: undefined },
            },
            {
                description: 'prefer the identity the environment sets over the options',
                apps: { identifier: 'from-config', name: 'Config Name' },
                env: { DATADOG_APPS_IDENTIFIER: ' from-env ', DD_APPS_NAME: 'Env Name' },
                expected: { identifier: 'from-env', name: 'Env Name' },
            },
            {
                description: 'read the identity from the environment alone',
                apps: {},
                env: { DD_APPS_IDENTIFIER: 'from-env', DATADOG_APPS_NAME: 'Env Name' },
                expected: { identifier: 'from-env', name: 'Env Name' },
            },
            {
                description: 'prefer DATADOG_ over DD_ variables',
                apps: {},
                env: { DATADOG_APPS_IDENTIFIER: 'datadog', DD_APPS_IDENTIFIER: 'dd' },
                expected: { identifier: 'datadog', name: undefined },
            },
            {
                description: 'fall back to the options when the environment value is blank',
                apps: { identifier: 'from-config', name: 'Config Name' },
                env: { DATADOG_APPS_IDENTIFIER: '  ', DATADOG_APPS_NAME: ' ' },
                expected: { identifier: 'from-config', name: 'Config Name' },
            },
        ];

        test.each(cases)('Should $description', ({ apps, env, expected }) => {
            Object.assign(process.env, env);
            const { identifier, name } = validateOptions({ apps });
            expect({ identifier, name }).toEqual(expected);
        });
    });

    test('passes through excludeSourcemaps', () => {
        expect(validateOptions({ apps: { excludeSourcemaps: true } }).excludeSourcemaps).toBe(true);
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
