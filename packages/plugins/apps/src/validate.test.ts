// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { validateOptions } from './validate';

describe('Apps Plugin - validateOptions', () => {
    test('uses package-only defaults', () => {
        expect(validateOptions({ apps: {} })).toEqual({
            include: [],
            longPolling: {
                maxRetries: 10,
                timeoutMs: 40000,
                jitter: true,
                exponentialBackoff: true,
            },
        });
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
