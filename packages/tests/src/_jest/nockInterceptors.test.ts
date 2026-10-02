// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isDeepStrictEqual } from 'util';

import { LEAKED_REQUESTS, SETTLED } from './nockLeakShared';

const jestPackagePath = require.resolve('jest/package.json');
const jestBinDir = path.dirname(jestPackagePath);
const JEST_BIN_PATH = path.join(jestBinDir, 'bin/jest.js');
const JEST_CONFIG_PATH = path.resolve(__dirname, '../../jest.config.ts');
const SETUP_AFTER_ENV_PATH = path.resolve(__dirname, 'setupAfterEnv.ts');
const NOOP_SETUP_PATH = path.resolve(__dirname, 'noopGlobalSetup.ts');
const TEARDOWN_PATH = path.resolve(__dirname, 'nockLeakTeardown.ts');
const SPAWN_TIMEOUT_MS = 20000;
const TEST_TIMEOUT_MS = SPAWN_TIMEOUT_MS + 5000;

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
    const result = spawnSync(
        process.execPath,
        [
            JEST_BIN_PATH,
            '--config',
            JEST_CONFIG_PATH,
            '--testMatch',
            '**/nockLeak.fixture.ts',
            '--globalSetup',
            NOOP_SETUP_PATH,
            '--globalTeardown',
            TEARDOWN_PATH,
            '--setupFilesAfterEnv',
            setupFilesAfterEnvPath,
            '--globals',
            fixtureGlobals,
            '--runInBand',
            '--ci',
            '--no-watchman',
        ],
        {
            encoding: 'utf8',
            timeout: SPAWN_TIMEOUT_MS,
            // Built from scratch so CI's NODE_OPTIONS dd-trace preload doesn't start in the child.
            env: {
                PATH: process.env.PATH,
                PROJECT_CWD: process.env.PROJECT_CWD,
                TMPDIR: process.env.TMPDIR,
                BUILD_PLUGINS_ENV: process.env.BUILD_PLUGINS_ENV,
                JEST_CONFIG_TRANSPILE_ONLY: process.env.JEST_CONFIG_TRANSPILE_ONLY,
            },
        },
    );
    const outcomes = LEAKED_REQUESTS.map((name) => {
        const markerPath = path.join(leakDir, name);
        return fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : 'missing';
    });

    if (result.error) {
        throw new Error(`Fixture run failed: ${result.error.message}\n${result.stderr}`);
    }
    return { status: result.status, outcomes, stderr: result.stderr };
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
            const { status, outcomes, stderr } = runLeakFixture(setupFilesAfterEnvPath);
            const warned = INTERCEPTOR_WARNING.test(stderr);
            const allSettled = LEAKED_REQUESTS.map(() => SETTLED);

            const actual = { status, outcomes, warned };
            const expected = { status: 0, outcomes: allSettled, warned: expectWarning };
            if (!isDeepStrictEqual(actual, expected)) {
                const actualText = JSON.stringify(actual);
                throw new Error(
                    `Unexpected fixture run ${actualText}\n--- child stderr ---\n${stderr}`,
                );
            }
            expect(actual).toEqual(expected);
        },
        TEST_TIMEOUT_MS,
    );
});
