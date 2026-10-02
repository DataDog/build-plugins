// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { spawnSync } from 'child_process';
import path from 'path';

import { ENV_OVERRIDE_VARIABLES } from './helpers/cleanEnv';

type JestJsonReport = {
    numTotalTests: number;
    testResults: {
        message: string;
        assertionResults: { title: string; status: string }[];
    }[];
};

const FAKE_SECRET_NAMES = [...ENV_OVERRIDE_VARIABLES, 'GITHUB_TOKEN'];
const fakeSecretEntries: [string, string][] = FAKE_SECRET_NAMES.map((name) => [
    name,
    `fake-${name}`,
]);
const FAKE_SECRETS = Object.fromEntries(fakeSecretEntries);
const jestPackagePath = require.resolve('jest/package.json');
const jestBinDir = path.dirname(jestPackagePath);
const JEST_BIN_PATH = path.join(jestBinDir, 'bin/jest.js');
const JEST_CONFIG_PATH = path.resolve(__dirname, '../../jest.config.ts');
const SETUP_AFTER_ENV_PATH = path.resolve(__dirname, 'setupAfterEnv.ts');
const SCRUB_GLOBAL_SETUP_PATH = path.resolve(__dirname, 'scrubEnvGlobalSetup.ts');
const NOOP_SETUP_PATH = path.resolve(__dirname, 'noopGlobalSetup.ts');
const SPAWN_TIMEOUT_MS = 15000;
const TEST_TIMEOUT_MS = SPAWN_TIMEOUT_MS + 5000;

type FixtureRun = {
    globalSetupPath: string;
    setupFilesAfterEnvPath: string;
    inWorker: boolean;
};

const runFixture = ({
    globalSetupPath,
    setupFilesAfterEnvPath,
    inWorker,
}: FixtureRun): JestJsonReport => {
    const fixtureGlobals = JSON.stringify({ FIXTURE_SCRUBBED_KEYS: FAKE_SECRET_NAMES });
    // Jest always uses workers once workerIdleMemoryLimit is set, even for a single test file.
    const executionArgs = inWorker
        ? ['--maxWorkers=1', '--workerIdleMemoryLimit=1GB']
        : ['--runInBand'];
    const result = spawnSync(
        process.execPath,
        [
            JEST_BIN_PATH,
            '--config',
            JEST_CONFIG_PATH,
            '--testMatch',
            '**/setupAfterEnv.fixture.ts',
            '--globalSetup',
            globalSetupPath,
            '--setupFilesAfterEnv',
            setupFilesAfterEnvPath,
            '--globals',
            fixtureGlobals,
            ...executionArgs,
            '--ci',
            '--no-watchman',
            '--json',
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
                ...FAKE_SECRETS,
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

// Every (secret, scope) pair the fixture found exposed, as "<NAME> from <scope>".
const getExposures = (report: JestJsonReport) => {
    const assertions = report.testResults.flatMap((file) => file.assertionResults);
    const failedPairs = assertions
        .filter((assertion) => assertion.status !== 'passed')
        .map((assertion) => assertion.title.replace(/^Should hide /, ''));
    const teardownPairs = report.testResults.flatMap((file) => {
        const match = /Exposed in teardown scope: ([^\n]+)/.exec(file.message);
        const names = match ? match[1].split(', ') : [];
        return names.map((name) => `${name} from teardown scope`);
    });
    return [...failedPairs, ...teardownPairs].sort();
};

const expectExposuresIn = (scopes: string[]) => {
    const pairs = scopes.flatMap((scope) =>
        FAKE_SECRET_NAMES.map((name) => `${name} from ${scope}`),
    );
    return pairs.sort();
};

const ALL_SCOPES = ['child processes', 'describe scope', 'module scope', 'teardown scope'];

describe('Test env scrub', () => {
    const cases = [
        {
            description: 'hide CI secrets from every scope with both layers',
            run: {
                globalSetupPath: SCRUB_GLOBAL_SETUP_PATH,
                setupFilesAfterEnvPath: SETUP_AFTER_ENV_PATH,
                inWorker: false,
            },
            exposedScopes: [],
        },
        {
            description:
                'hide CI secrets from test code, not child processes, with only setupAfterEnv',
            run: {
                globalSetupPath: NOOP_SETUP_PATH,
                setupFilesAfterEnvPath: SETUP_AFTER_ENV_PATH,
                inWorker: false,
            },
            exposedScopes: ['child processes'],
        },
        {
            description: 'hide CI secrets from every scope with only the globalSetup scrub',
            run: {
                globalSetupPath: SCRUB_GLOBAL_SETUP_PATH,
                setupFilesAfterEnvPath: NOOP_SETUP_PATH,
                inWorker: false,
            },
            exposedScopes: [],
        },
        {
            description:
                'hide CI secrets from every scope in a forked worker with only the globalSetup scrub',
            run: {
                globalSetupPath: SCRUB_GLOBAL_SETUP_PATH,
                setupFilesAfterEnvPath: NOOP_SETUP_PATH,
                inWorker: true,
            },
            exposedScopes: [],
        },
        {
            description: 'expose CI secrets everywhere with neither, as a positive control',
            run: {
                globalSetupPath: NOOP_SETUP_PATH,
                setupFilesAfterEnvPath: NOOP_SETUP_PATH,
                inWorker: false,
            },
            exposedScopes: ALL_SCOPES,
        },
        {
            description:
                'expose CI secrets everywhere in a forked worker with neither, as a positive control',
            run: {
                globalSetupPath: NOOP_SETUP_PATH,
                setupFilesAfterEnvPath: NOOP_SETUP_PATH,
                inWorker: true,
            },
            exposedScopes: ALL_SCOPES,
        },
    ];

    test.each(cases)(
        'Should $description',
        ({ run, exposedScopes }) => {
            const report = runFixture(run);
            const exposures = getExposures(report);
            const expectedExposures = expectExposuresIn(exposedScopes);

            expect(report.numTotalTests).toBeGreaterThan(0);
            expect(exposures).toEqual(expectedExposures);
        },
        TEST_TIMEOUT_MS,
    );
});
