// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { isDeepStrictEqual } from 'util';

import {
    FIXTURE_TEST_TIMEOUT_MS,
    NOOP_SETUP_PATH,
    parseJestReport,
    spawnJestFixture,
} from './helpers/spawnJestFixture';
import { CHAIN_FILE_COUNT } from './nockChainShared';
import { LEAKED_REQUESTS, SETTLED } from './nockLeakShared';

const SETUP_AFTER_ENV_PATH = path.resolve(__dirname, 'setupAfterEnv.ts');
const TEARDOWN_PATH = path.resolve(__dirname, 'nockLeakTeardown.ts');
const REACTIVATE_SETUP_PATH = path.resolve(__dirname, 'nockReactivateSetup.ts');
const STACKED_INTERCEPTOR_ERROR = 'Cannot convert undefined or null to object';

const runLeakFixture = (setupFilesAfterEnvPath: string) => {
    const tmpDir = os.tmpdir();
    const leakDirPrefix = path.join(tmpDir, 'nock-leak-');
    const leakDir = fs.mkdtempSync(leakDirPrefix);
    const fixtureGlobals = JSON.stringify({ NOCK_LEAK_DIR: leakDir });
    try {
        return runInLeakDir(leakDir, fixtureGlobals, setupFilesAfterEnvPath);
    } finally {
        fs.rmSync(leakDir, { recursive: true, force: true });
    }
};

const runInLeakDir = (leakDir: string, fixtureGlobals: string, setupFilesAfterEnvPath: string) => {
    const run = spawnJestFixture(
        '**/nockLeak.fixture.ts',
        [
            '--globalTeardown',
            TEARDOWN_PATH,
            '--setupFilesAfterEnv',
            setupFilesAfterEnvPath,
            '--globals',
            fixtureGlobals,
        ],
        {},
    );
    const outcomes = LEAKED_REQUESTS.map((name) => {
        const markerPath = path.join(leakDir, name);
        return fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : 'missing';
    });
    return { status: run.status, outcomes, stderr: run.stderr, output: run.output };
};

// Node 22 handles the same leak without touching the interceptors, so neither case can tell
// anything apart there. They run before Node 22, which covers the Node 20 the repo pins.
const nodeMajorVersion = process.versions.node.split('.')[0];
const describeBeforeNode22 = Number(nodeMajorVersion) < 22 ? describe : describe.skip;
const INTERCEPTOR_WARNING = /JEST-01.*accessed on \[\w*Interceptor\]/;

describeBeforeNode22("nock's interceptors and Jest's per-file global cleanup", () => {
    const cases = [
        {
            description: 'not warn when requests settle after their test file ended',
            setupFilesAfterEnvPath: SETUP_AFTER_ENV_PATH,
            expectWarning: false,
        },
        {
            description: 'warn without setupAfterEnv, as a positive control',
            setupFilesAfterEnvPath: NOOP_SETUP_PATH,
            expectWarning: true,
        },
    ];

    test.each(cases)(
        'Should $description',
        ({ setupFilesAfterEnvPath, expectWarning }) => {
            const { status, outcomes, stderr, output } = runLeakFixture(setupFilesAfterEnvPath);
            const warned = INTERCEPTOR_WARNING.test(stderr);
            const allSettled = LEAKED_REQUESTS.map(() => SETTLED);

            const actual = { status, outcomes, warned };
            const expected = { status: 0, outcomes: allSettled, warned: expectWarning };
            if (!isDeepStrictEqual(actual, expected)) {
                const actualText = JSON.stringify(actual);
                throw new Error(`Unexpected fixture run ${actualText}\n${output}`);
            }
            expect(actual).toEqual(expected);
        },
        FIXTURE_TEST_TIMEOUT_MS,
    );
});

const runChainFixtures = (setupFilesAfterEnvPaths: string[]) => {
    const run = spawnJestFixture(
        '**/nockChain?.fixture.ts',
        ['--setupFilesAfterEnv', ...setupFilesAfterEnvPaths, '--json'],
        {},
    );
    const report = parseJestReport(run);
    const stackedFiles = report.testResults.filter((file) =>
        file.message.includes(STACKED_INTERCEPTOR_ERROR),
    );
    const actual = {
        passed: report.numPassedTests,
        failed: report.numFailedTests,
        stackedFailures: stackedFiles.length,
        runtimeErrors: report.numRuntimeErrorTestSuites,
    };
    return { actual, output: run.output };
};

describe('nock across the test files of one worker', () => {
    const cases = [
        {
            description: 'mock requests in every file',
            setupFilesAfterEnvPaths: [SETUP_AFTER_ENV_PATH],
            expected: { passed: CHAIN_FILE_COUNT, failed: 0, stackedFailures: 0, runtimeErrors: 0 },
        },
        {
            description: 'break every later file when nock is re-activated, as a positive control',
            setupFilesAfterEnvPaths: [SETUP_AFTER_ENV_PATH, REACTIVATE_SETUP_PATH],
            expected: {
                passed: 1,
                failed: CHAIN_FILE_COUNT - 1,
                stackedFailures: CHAIN_FILE_COUNT - 1,
                runtimeErrors: 0,
            },
        },
    ];

    test.each(cases)(
        'Should $description',
        ({ setupFilesAfterEnvPaths, expected }) => {
            const { actual, output } = runChainFixtures(setupFilesAfterEnvPaths);
            if (!isDeepStrictEqual(actual, expected)) {
                const actualText = JSON.stringify(actual);
                throw new Error(`Unexpected fixture run ${actualText}\n${output}`);
            }
            expect(actual).toEqual(expected);
        },
        FIXTURE_TEST_TIMEOUT_MS,
    );
});
