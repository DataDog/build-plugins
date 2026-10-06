// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { spawnSync } from 'child_process';
import path from 'path';

type JestJsonReport = {
    numFailedTests: number;
    numPassedTests: number;
    numRuntimeErrorTestSuites: number;
    numTotalTests: number;
    testResults: { message: string }[];
};

const jestPackagePath = require.resolve('jest/package.json');
const jestBinDir = path.dirname(jestPackagePath);
const JEST_BIN_PATH = path.join(jestBinDir, 'bin/jest.js');
const JEST_CONFIG_PATH = path.resolve(__dirname, '../../../jest.config.ts');
export const NOOP_SETUP_PATH = path.resolve(__dirname, '../noopGlobalSetup.ts');
const SPAWN_TIMEOUT_MS = 20000;
export const FIXTURE_TEST_TIMEOUT_MS = SPAWN_TIMEOUT_MS + 5000;

// Runs the fixture files matching `testMatch` together in one spawned Jest process.
export const spawnJestFixture = (
    testMatch: string,
    extraArgs: string[],
    extraEnv: Record<string, string>,
) => {
    const result = spawnSync(
        process.execPath,
        [
            JEST_BIN_PATH,
            '--config',
            JEST_CONFIG_PATH,
            '--testMatch',
            testMatch,
            '--globalSetup',
            NOOP_SETUP_PATH,
            ...extraArgs,
            '--runInBand',
            '--ci',
            '--no-watchman',
        ],
        {
            encoding: 'utf8',
            timeout: SPAWN_TIMEOUT_MS,
            // Built from scratch so CI's NODE_OPTIONS dd-trace preload doesn't start in the child and
            // report with fake keys a caller passes.
            env: {
                PATH: process.env.PATH,
                PROJECT_CWD: process.env.PROJECT_CWD,
                TMPDIR: process.env.TMPDIR,
                BUILD_PLUGINS_ENV: process.env.BUILD_PLUGINS_ENV,
                JEST_CONFIG_TRANSPILE_ONLY: process.env.JEST_CONFIG_TRANSPILE_ONLY,
                // Keeps the child's console off stdout, which carries the --json report.
                JEST_SILENT: '1',
                ...extraEnv,
            },
        },
    );

    const output = `status: ${result.status}, signal: ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    if (result.error) {
        throw new Error(`Fixture run failed: ${result.error.message}\n${output}`);
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, output };
};

const REPORT_COUNT_KEYS = [
    'numFailedTests',
    'numPassedTests',
    'numRuntimeErrorTestSuites',
    'numTotalTests',
] as const;

const isJestJsonReport = (value: unknown): value is JestJsonReport => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const hasCounts = REPORT_COUNT_KEYS.every((key) => typeof Reflect.get(value, key) === 'number');
    const testResults: unknown = Reflect.get(value, 'testResults');
    return (
        hasCounts &&
        Array.isArray(testResults) &&
        testResults.every(
            (file: unknown) =>
                typeof file === 'object' &&
                file !== null &&
                typeof Reflect.get(file, 'message') === 'string',
        )
    );
};

export const parseJestReport = (run: { stdout: string; output: string }): JestJsonReport => {
    let report: unknown;
    try {
        report = JSON.parse(run.stdout);
    } catch {
        throw new Error(`Fixture run produced no JSON report.\n${run.output}`);
    }
    if (!isJestJsonReport(report)) {
        throw new Error(`Fixture run produced an unexpected JSON report.\n${run.output}`);
    }
    return report;
};
