// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';

import { ENV_OVERRIDE_VARIABLES } from './helpers/datadogEnv';
import type { JestJsonReport } from './helpers/spawnJestFixture';
import {
    FIXTURE_TEST_TIMEOUT_MS,
    NOOP_SETUP_PATH,
    parseJestReport,
    spawnJestFixture,
} from './helpers/spawnJestFixture';
import {
    ALL_SCOPES,
    CHILD_PROCESSES_SCOPE,
    PROCESS_ID_TEST_TITLE_PREFIX,
    EXPOSURE_TEST_TITLE_PREFIX,
    TEARDOWN_EXPOSURE_PREFIX,
    TEARDOWN_SCOPE,
    getExposureLabel,
} from './setupAfterEnvFixtureLabels';

const NAMED_SECRETS = [...ENV_OVERRIDE_VARIABLES, 'GITHUB_TOKEN'];
const namedSecretEntries: [string, string][] = NAMED_SECRETS.map((name) => [name, `fake-${name}`]);
const FAKE_SECRETS: Record<string, string> = {
    ...Object.fromEntries(namedSecretEntries),
    // An allowed name, removed only because its value carries URL credentials.
    DD_TRACE_AGENT_URL: 'http://fake-user:fake-token@127.0.0.1:8126',
};
const FAKE_SECRET_NAMES = Object.keys(FAKE_SECRETS);
const SETUP_AFTER_ENV_PATH = path.resolve(__dirname, 'setupAfterEnv.ts');
const SCRUB_GLOBAL_SETUP_PATH = path.resolve(__dirname, 'scrubEnvGlobalSetup.ts');

type FixtureRun = {
    globalSetupPath: string;
    setupFilesAfterEnvPath: string;
    inWorker: boolean;
};

const runFixture = ({
    globalSetupPath,
    setupFilesAfterEnvPath,
    inWorker,
}: FixtureRun): { report: JestJsonReport; jestProcessId: number } => {
    const fixtureGlobals = JSON.stringify({ FIXTURE_SCRUBBED_KEYS: FAKE_SECRET_NAMES });
    // Jest always uses workers once workerIdleMemoryLimit is set, even for a single test file.
    const executionArgs = inWorker
        ? ['--maxWorkers=1', '--workerIdleMemoryLimit=1GB']
        : ['--runInBand'];
    const run = spawnJestFixture(
        '**/setupAfterEnv.fixture.ts',
        ['--setupFilesAfterEnv', setupFilesAfterEnvPath, '--globals', fixtureGlobals, '--json'],
        FAKE_SECRETS,
        { globalSetupPath, executionArgs },
    );
    const report = parseJestReport(run);
    return { report, jestProcessId: run.pid };
};

const getExposures = (report: JestJsonReport) => {
    const assertions = report.testResults.flatMap((file) => file.assertionResults);
    const failedPairs = assertions
        .filter((assertion) => assertion.title.startsWith(EXPOSURE_TEST_TITLE_PREFIX))
        .filter((assertion) => assertion.status !== 'passed')
        .map((assertion) => assertion.title.slice(EXPOSURE_TEST_TITLE_PREFIX.length));
    const teardownPairs = report.testResults.flatMap((file) => {
        const prefixIndex = file.message.indexOf(TEARDOWN_EXPOSURE_PREFIX);
        if (prefixIndex === -1) {
            return [];
        }
        const listStart = prefixIndex + TEARDOWN_EXPOSURE_PREFIX.length;
        const [exposedList] = file.message.slice(listStart).split('\n');
        const names = exposedList.split(', ');
        return names.map((name) => getExposureLabel(name, TEARDOWN_SCOPE));
    });
    return [...failedPairs, ...teardownPairs].sort();
};

const getExpectedExposures = (scopes: string[]) => {
    const pairs = scopes.flatMap((scope) =>
        FAKE_SECRET_NAMES.map((name) => getExposureLabel(name, scope)),
    );
    return pairs.sort();
};

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
            exposedScopes: [CHILD_PROCESSES_SCOPE],
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
            const { report, jestProcessId } = runFixture(run);
            const exposures = getExposures(report);
            const expectedExposures = getExpectedExposures(exposedScopes);
            const assertions = report.testResults.flatMap((file) => file.assertionResults);
            const processIdTitle = assertions.find((assertion) =>
                assertion.title.startsWith(PROCESS_ID_TEST_TITLE_PREFIX),
            )?.title;
            const processIdText = processIdTitle?.slice(PROCESS_ID_TEST_TITLE_PREFIX.length);
            const fixtureProcessId = Number(processIdText);
            const ranInWorker = fixtureProcessId !== jestProcessId;
            const fileMessages = report.testResults.map((file) => file.message);
            const isFixtureFileClean = fileMessages.every((message) => message === '');

            expect(report.numTotalTests).toBeGreaterThan(0);
            expect(fixtureProcessId).toBeGreaterThan(0);
            expect(ranInWorker).toBe(run.inWorker);
            expect(isFixtureFileClean).toBe(expectedExposures.length === 0);
            expect(exposures).toEqual(expectedExposures);
        },
        FIXTURE_TEST_TIMEOUT_MS,
    );
});
