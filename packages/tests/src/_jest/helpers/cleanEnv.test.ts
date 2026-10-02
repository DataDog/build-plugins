// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { cleanEnv, ENV_OVERRIDE_VARIABLES } from './cleanEnv';

const UNLISTED_KEY = 'DD_CLEAN_ENV_TEST_UNLISTED';

const setOverrideVariables = (value: string | undefined) => {
    for (const key of ENV_OVERRIDE_VARIABLES) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
};

describe('cleanEnv', () => {
    afterEach(() => {
        setOverrideVariables(undefined);
        delete process.env[UNLISTED_KEY];
    });

    const cases = [
        {
            description: 'remove every override variable',
            initial: 'initial-value',
            setAfterClean: undefined,
            restore: false,
            expected: undefined,
        },
        {
            description: 'restore the values it removed',
            initial: 'initial-value',
            setAfterClean: undefined,
            restore: true,
            expected: 'initial-value',
        },
        {
            description: 'remove values set after cleaning that were unset before',
            initial: undefined,
            setAfterClean: 'later-value',
            restore: true,
            expected: undefined,
        },
    ];

    test.each(cases)('Should $description', ({ initial, setAfterClean, restore, expected }) => {
        setOverrideVariables(initial);

        const restoreEnv = cleanEnv();
        if (setAfterClean !== undefined) {
            setOverrideVariables(setAfterClean);
        }
        if (restore) {
            restoreEnv();
        }

        for (const key of ENV_OVERRIDE_VARIABLES) {
            expect(process.env[key]).toBe(expected);
        }
    });

    test('Should leave variables outside the override list untouched', () => {
        process.env[UNLISTED_KEY] = 'kept';

        const restoreEnv = cleanEnv();
        expect(process.env[UNLISTED_KEY]).toBe('kept');
        restoreEnv();
        expect(process.env[UNLISTED_KEY]).toBe('kept');
    });
});
