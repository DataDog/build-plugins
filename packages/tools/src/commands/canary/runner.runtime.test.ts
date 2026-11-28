// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, readFile, rm } from '@dd/core/helpers/fs';
import os from 'os';
import path from 'path';

import { runCanary } from './runner';
import type { RuntimeBenchmarkResult, RuntimeLoad, RuntimeSettings } from './runtime';
import {
    ChromeConnectionError,
    createRandom,
    launchChrome,
    RuntimeAbortedError,
    runRuntimeBenchmark,
    RuntimeVariantError,
    summarizeLoads,
} from './runtime';
import type { CanaryPhase, CanaryTarget, CanaryVariant, RunCommand } from './types';
import { CANARY_VARIANTS } from './types';

// The runner's own failure handling, without Chrome: the engine is faked.
jest.mock('./runtime', () => {
    const original = jest.requireActual('./runtime');
    return {
        ...original,
        launchChrome: jest.fn(),
        runRuntimeBenchmark: jest.fn(),
    };
});

const mockLaunchChrome = jest.mocked(launchChrome);
const mockRunRuntimeBenchmark = jest.mocked(runRuntimeBenchmark);

const TEST_ROOT = path.resolve(os.tmpdir(), `build-plugins-canary-runtime-${process.pid}`);
const PHASE_ID = 'vite-app';
const PAGE = { id: 'home', path: '/', readySelector: 'main' };
const SETTINGS: RuntimeSettings = {
    repetitions: 10,
    cpuThrottlingRates: [1],
    network: null,
    lcpSettleMs: 1_000,
    maxWaitMs: 5_000,
    bootstrapResamples: 10,
};

const runCommand: RunCommand = async () => ({
    durationMs: 1,
    exitCode: 0,
    output: '',
    signal: null,
});

const createPhase = (): CanaryPhase => ({
    id: PHASE_ID,
    buildTool: 'vite',
    localPackages: ['@datadog/vite-plugin'],
    getArtifactSpec: (_root, variant) => ({
        roots: [path.resolve(TEST_ROOT, variant)],
        patterns: ['**/*.js'],
    }),
    getBuildCommand: (_root, variant) => ({
        command: 'synthetic-build',
        args: [],
        cwd: TEST_ROOT,
        label: `build:${variant}`,
    }),
    assertBuildOutput: () => undefined,
    assertArtifacts: async () => undefined,
    runtime: {
        getServeRoot: (_root, variant) => path.resolve(TEST_ROOT, variant),
        immutablePaths: /^\/assets\//,
        pages: [PAGE],
        chromeFlags: [],
    },
});

const target: CanaryTarget = {
    id: 'synthetic',
    repository: { name: 'example/synthetic', branch: 'main' },
    getDefaultRoot: () => TEST_ROOT,
    getPhases: () => [createPhase()],
    install: async () => undefined,
    preflight: async () => undefined,
    setup: async () => undefined,
};

const createLoad = (
    variant: CanaryVariant,
    cache: 'cold' | 'warm',
    repetition: number,
    ok: boolean,
): RuntimeLoad<CanaryVariant> => ({
    repetition,
    variant,
    page: PAGE.id,
    cache,
    cpuThrottling: 1,
    ok,
    error: ok ? null : 'Timed out.',
    metrics: {
        fcpMs: ok ? 500 : null,
        lcpMs: ok ? 700 : null,
        scriptMs: ok ? 200 : null,
        blockingBeforeLcpMs: ok ? 100 : null,
        jsTransferBytes: 1_000,
        jsDecodedBytes: 3_000,
    },
    jsRequests: 2,
    pageErrors: 0,
    failedRequests: 0,
});

// Every load succeeds, except the first failedLoads cold loads of failingVariant.
const createResult = (
    failingVariant: CanaryVariant,
    failedLoads: number,
): RuntimeBenchmarkResult<CanaryVariant> => {
    const loads: RuntimeLoad<CanaryVariant>[] = [];
    for (let repetition = 0; repetition < SETTINGS.repetitions; repetition++) {
        for (const variant of CANARY_VARIANTS) {
            const failed = variant === failingVariant && repetition < failedLoads;
            loads.push(createLoad(variant, 'cold', repetition, !failed));
            loads.push(createLoad(variant, 'warm', repetition, true));
        }
    }
    const conditions = summarizeLoads({
        controlVariant: 'control',
        loads,
        pages: [PAGE],
        random: createRandom('seed'),
        settings: SETTINGS,
        variants: [...CANARY_VARIANTS],
    });
    return {
        browser: { version: 'HeadlessChrome/1' },
        durationMs: 1,
        pages: [{ id: PAGE.id, path: PAGE.path }],
        conditions,
        loads,
    };
};

const runWithRuntime = async (): Promise<unknown> => {
    const reportPath = path.resolve(TEST_ROOT, 'report.json');
    const run = runCanary({
        abortSignal: undefined,
        alert: undefined,
        buildPluginsRoot: process.cwd(),
        cleanup: true,
        install: false,
        networkRetryDelaysMs: [],
        phaseSelection: 'all',
        reportPath,
        root: TEST_ROOT,
        runCommand,
        runId: 'runtime-run',
        runtime: { chromePath: '/fake/chrome', settings: SETTINGS },
        target,
    });
    // Failed runs reject; the report says why.
    await run.catch(() => undefined);
    return JSON.parse(await readFile(reportPath));
};

describe('canary runner runtime step', () => {
    beforeEach(async () => {
        await rm(TEST_ROOT);
        for (const variant of CANARY_VARIANTS) {
            await outputFile(path.resolve(TEST_ROOT, variant, 'app.js'), 'function app() {}');
        }
        mockLaunchChrome.mockResolvedValue({
            version: 'HeadlessChrome/1',
            newPage: jest.fn(),
            close: async () => undefined,
        });
    });

    afterAll(async () => {
        await rm(TEST_ROOT);
    });

    const failureCases = [
        {
            description: 'report Chrome failing as a target failure',
            error: new ChromeConnectionError('The DevTools connection closed.'),
            expected: { failureKind: 'target', stage: `phase:${PHASE_ID}:runtime` },
        },
        {
            description: "blame the plugin when an instrumented build doesn't load",
            error: new RuntimeVariantError("all-functions didn't load home.", 'all-functions'),
            expected: { failureKind: 'plugin', stage: `phase:${PHASE_ID}:all-functions:runtime` },
        },
        {
            description: "blame the target when control doesn't load",
            error: new RuntimeVariantError("control didn't load home.", 'control'),
            expected: { failureKind: 'target', stage: `phase:${PHASE_ID}:control:runtime` },
        },
        {
            description: 'report a stop as an interruption',
            error: new RuntimeAbortedError('The runtime benchmark was stopped.'),
            expected: { failureKind: 'interrupted', stage: `phase:${PHASE_ID}:runtime` },
        },
    ];

    test.each(failureCases)('should $description', async ({ error, expected }) => {
        mockRunRuntimeBenchmark.mockRejectedValue(error);

        const report = await runWithRuntime();

        expect(report).toMatchObject({
            status: 'failed',
            failureKind: expected.failureKind,
            failures: [{ stage: expected.stage }],
        });
    });

    test('should blame the plugin when an instrumented variant fails too many loads', async () => {
        mockRunRuntimeBenchmark.mockResolvedValue(createResult('named-only', 2));

        const report = await runWithRuntime();

        expect(report).toMatchObject({
            status: 'failed',
            failureKind: 'plugin',
            failures: [
                {
                    stage: `phase:${PHASE_ID}:named-only:runtime`,
                    message:
                        'named-only failed 2 of 10 loads of home (cold cache, CPU 1x), more than 10%.',
                },
            ],
        });
    });

    test('should pass when every variant loads often enough', async () => {
        mockRunRuntimeBenchmark.mockResolvedValue(createResult('named-only', 1));

        const report = await runWithRuntime();

        expect(report).toMatchObject({ status: 'passed', failures: [] });
    });
});
