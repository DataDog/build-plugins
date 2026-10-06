// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { ENV_OVERRIDE_VARIABLES } from './helpers/cleanEnv';
import {
    FIXTURE_TEST_TIMEOUT_MS,
    NOOP_SETUP_PATH,
    parseJestReport,
    spawnJestFixture,
} from './helpers/spawnJestFixture';

const fakeOverrideEntries: [string, string][] = ENV_OVERRIDE_VARIABLES.map((key) => [
    key,
    `fake-${key}`,
]);
const FAKE_OVERRIDE_ENV = Object.fromEntries(fakeOverrideEntries);

const runFixture = (extraArgs: string[]) => {
    const fixtureScrubbedKeys = ENV_OVERRIDE_VARIABLES.join(',');
    const run = spawnJestFixture('**/setupAfterEnv.fixture.ts', ['--json', ...extraArgs], {
        FIXTURE_SCRUBBED_KEYS: fixtureScrubbedKeys,
        ...FAKE_OVERRIDE_ENV,
    });
    return parseJestReport(run);
};

describe('setupAfterEnv', () => {
    test(
        'Should keep Datadog env variables out of test files from collection to teardown',
        () => {
            const report = runFixture([]);
            const failureMessages = report.testResults.map((file) => file.message);

            expect(failureMessages).toEqual(['']);
            expect(report.numTotalTests).toBeGreaterThan(0);
            expect(report.numPassedTests).toBe(report.numTotalTests);
        },
        FIXTURE_TEST_TIMEOUT_MS,
    );

    test(
        'Should expose them in every scope without the scrub, as a positive control',
        () => {
            const report = runFixture(['--setupFilesAfterEnv', NOOP_SETUP_PATH]);
            const failureMessages = report.testResults.map((file) => file.message);

            expect(report.numTotalTests).toBeGreaterThan(0);
            expect(report.numFailedTests).toBe(report.numTotalTests);
            expect(failureMessages[0]).toContain('Exposed in teardown scope');
        },
        FIXTURE_TEST_TIMEOUT_MS,
    );
});
