// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parseJestReport } from './spawnJestFixture';

const validReport = {
    numFailedTests: 0,
    numPassedTests: 1,
    numRuntimeErrorTestSuites: 0,
    numTotalTests: 1,
    testResults: [{ message: '' }],
};
const OUTPUT = 'status: 1, signal: null';

const getOutcome = (stdout: string) => {
    try {
        return { report: parseJestReport({ stdout, output: OUTPUT }) };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: message };
    }
};

describe('parseJestReport', () => {
    const cases = [
        {
            description: 'return a well-formed report',
            stdout: JSON.stringify(validReport),
            expected: { report: validReport },
        },
        {
            description: 'throw with the run output when stdout is not JSON',
            stdout: 'console output\n{}',
            expected: { error: `Fixture run produced no JSON report.\n${OUTPUT}` },
        },
        {
            description: 'throw with the run output when testResults is missing',
            stdout: JSON.stringify({ ...validReport, testResults: undefined }),
            expected: { error: `Fixture run produced an unexpected JSON report.\n${OUTPUT}` },
        },
        {
            description: 'throw with the run output when a count is not a number',
            stdout: JSON.stringify({ ...validReport, numPassedTests: '1' }),
            expected: { error: `Fixture run produced an unexpected JSON report.\n${OUTPUT}` },
        },
        {
            description: 'throw with the run output when a test result has no message',
            stdout: JSON.stringify({ ...validReport, testResults: [{}] }),
            expected: { error: `Fixture run produced an unexpected JSON report.\n${OUTPUT}` },
        },
    ];

    test.each(cases)('Should $description', ({ stdout, expected }) => {
        const outcome = getOutcome(stdout);
        expect(outcome).toEqual(expected);
    });
});
