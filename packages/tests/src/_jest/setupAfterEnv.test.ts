// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { spawnSync } from 'child_process';
import path from 'path';

import { ENV_OVERRIDE_VARIABLES } from './helpers/cleanEnv';

type JestJsonReport = {
    numFailedTests: number;
    numPassedTests: number;
    numTotalTests: number;
    testResults: { message: string }[];
};

const fakeOverrideEntries: [string, string][] = ENV_OVERRIDE_VARIABLES.map((key) => [
    key,
    `fake-${key}`,
]);
const FAKE_OVERRIDE_ENV = Object.fromEntries(fakeOverrideEntries);
const jestPackagePath = require.resolve('jest/package.json');
const jestBinDir = path.dirname(jestPackagePath);
const JEST_BIN_PATH = path.join(jestBinDir, 'bin/jest.js');
const JEST_CONFIG_PATH = path.resolve(__dirname, '../../jest.config.ts');
const NOOP_SETUP_PATH = path.resolve(__dirname, 'noopGlobalSetup.ts');
const SPAWN_TIMEOUT_MS = 15000;
const TEST_TIMEOUT_MS = SPAWN_TIMEOUT_MS + 5000;

const runFixture = (extraArgs: string[]): JestJsonReport => {
    const fixtureScrubbedKeys = ENV_OVERRIDE_VARIABLES.join(',');
    const result = spawnSync(
        process.execPath,
        [
            JEST_BIN_PATH,
            '--config',
            JEST_CONFIG_PATH,
            '--testMatch',
            '**/setupAfterEnv.fixture.ts',
            '--globalSetup',
            NOOP_SETUP_PATH,
            '--runInBand',
            '--ci',
            '--no-watchman',
            '--json',
            ...extraArgs,
        ],
        {
            encoding: 'utf8',
            timeout: SPAWN_TIMEOUT_MS,
            // Built from scratch so CI's NODE_OPTIONS dd-trace preload doesn't start in the child
            // and report with the fake key.
            env: {
                PATH: process.env.PATH,
                PROJECT_CWD: process.env.PROJECT_CWD,
                TMPDIR: process.env.TMPDIR,
                BUILD_PLUGINS_ENV: process.env.BUILD_PLUGINS_ENV,
                JEST_CONFIG_TRANSPILE_ONLY: process.env.JEST_CONFIG_TRANSPILE_ONLY,
                // Keeps the child's console off stdout, which carries the --json report.
                JEST_SILENT: '1',
                FIXTURE_SCRUBBED_KEYS: fixtureScrubbedKeys,
                ...FAKE_OVERRIDE_ENV,
            },
        },
    );

    const output = `status: ${result.status}, signal: ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    if (result.error) {
        throw new Error(`Fixture run failed: ${result.error.message}\n${output}`);
    }
    try {
        return JSON.parse(result.stdout);
    } catch {
        throw new Error(`Fixture run produced no JSON report.\n${output}`);
    }
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
        TEST_TIMEOUT_MS,
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
        TEST_TIMEOUT_MS,
    );
});
