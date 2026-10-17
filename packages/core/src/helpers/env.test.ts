// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDDEnvValue, getUsedKey, notifyOnEnvOverrides } from '@dd/core/helpers/env';
import { clearDatadogEnv } from '@dd/tests/_jest/helpers/datadogEnv';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';

describe('Core Helpers', () => {
    let restoreEnv: () => void;

    beforeEach(() => {
        restoreEnv = clearDatadogEnv();
    });

    afterEach(() => {
        restoreEnv();
    });

    describe('getDDEnvValue', () => {
        const cases = [
            {
                description: 'return undefined when neither variable is set',
                key: 'SITE',
                env: {},
                expected: undefined,
            },
            {
                description: 'prefer DATADOG_ over DD_',
                key: 'SITE',
                env: { DATADOG_SITE: 'datadoghq.eu', DD_SITE: 'us5.datadoghq.com' },
                expected: 'datadoghq.eu',
            },
            {
                description: 'return the empty string when the only variable is empty',
                key: 'SITE',
                env: { DD_SITE: '' },
                expected: '',
            },
            {
                description: 'fall back to DD_ when DATADOG_ is empty',
                key: 'API_KEY',
                env: { DATADOG_API_KEY: '', DD_API_KEY: 'api-key' },
                expected: 'api-key',
            },
            {
                description: 'pass a whitespace-only value through as-is',
                key: 'API_KEY',
                env: { DATADOG_API_KEY: '  ', DD_API_KEY: 'api-key' },
                expected: '  ',
            },
        ] as const;

        test.each(cases)('should $description', ({ key, env, expected }) => {
            Object.assign(process.env, env);
            expect(getDDEnvValue(key)).toBe(expected);
        });
    });

    describe('getUsedKey', () => {
        const cases = [
            {
                description: 'list every set variable',
                env: { DATADOG_SITE: 'datadoghq.eu', DD_SITE: '  ' },
                expected: ['DD_SITE', 'DATADOG_SITE'],
            },
            {
                description: 'skip empty variables',
                env: { DATADOG_SITE: '', DD_SITE: '' },
                expected: [],
            },
        ];

        test.each(cases)('should $description', ({ env, expected }) => {
            Object.assign(process.env, env);
            expect(getUsedKey('SITE')).toEqual(expected);
        });
    });

    describe('notifyOnEnvOverrides', () => {
        const cases = [
            {
                description: 'warn when both variables hold different values',
                env: { DATADOG_SITE: 'datadoghq.eu', DD_SITE: 'us5.datadoghq.com' },
                expectedWarnings: 1,
            },
            {
                description: 'not warn when one of the variables is empty',
                env: { DATADOG_SITE: '', DD_SITE: 'datadoghq.eu' },
                expectedWarnings: 0,
            },
        ];

        test.each(cases)('should $description', ({ env, expectedWarnings }) => {
            Object.assign(process.env, env);
            notifyOnEnvOverrides(getMockLogger());
            const warnings = mockLogFn.mock.calls.filter(([, level]) => level === 'warn');
            expect(warnings).toHaveLength(expectedWarnings);
        });
    });
});
