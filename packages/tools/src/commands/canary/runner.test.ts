// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, readFile, rm } from '@dd/core/helpers/fs';
import os from 'os';
import path from 'path';
import { gzipSync } from 'zlib';

import { createMetricComparison, getVariantOrder, measureArtifacts, runCanary } from './runner';
import type { CanaryPhase, CanaryTarget, CommandResult, CommandSpec, RunCommand } from './types';

const TEST_ROOT = path.resolve(os.tmpdir(), `build-plugins-canary-runner-${process.pid}`);

const successfulResult = (durationMs: number, output = ''): CommandResult => {
    return {
        durationMs,
        exitCode: 0,
        output,
        signal: null,
    };
};

const createCommand = (root: string, label: string): CommandSpec => {
    return {
        command: 'synthetic-build',
        args: [],
        cwd: root,
        label,
    };
};

const createSyntheticPhase = (root: string): CanaryPhase => {
    return {
        id: 'webpack-production',
        buildTool: 'webpack',
        localPackages: ['@datadog/webpack-plugin'],
        getArtifactSpec: (_targetRoot, variant) => ({
            roots: [path.resolve(root, variant)],
            patterns: ['**/*.js'],
        }),
        getBuildCommand: (_targetRoot, variant) => createCommand(root, `build:${variant}`),
        getValidationCommand: (_targetRoot, variant) => createCommand(root, `validate:${variant}`),
        assertBuildOutput: () => undefined,
    };
};

const createSyntheticTarget = (root: string, cleanupOrder: string[]): CanaryTarget => {
    return {
        id: 'synthetic',
        getDefaultRoot: () => root,
        getPhases: () => [createSyntheticPhase(root)],
        preflight: async () => undefined,
        setup: async ({ registerCleanup }) => {
            registerCleanup({
                name: 'first',
                run: async () => {
                    cleanupOrder.push('first');
                },
            });
            registerCleanup({
                name: 'second',
                run: async () => {
                    cleanupOrder.push('second');
                },
            });
        },
    };
};

describe('canary runner', () => {
    beforeEach(async () => {
        await rm(TEST_ROOT);
    });

    afterAll(async () => {
        await rm(TEST_ROOT);
    });

    test('should calculate absolute and percentage deltas', () => {
        expect(createMetricComparison(100, 125)).toEqual({
            control: 100,
            instrumented: 125,
            delta: 25,
            deltaPercent: 25,
        });
        expect(createMetricComparison(0, 10)).toEqual({
            control: 0,
            instrumented: 10,
            delta: 10,
            deltaPercent: null,
        });
    });

    test('should choose a stable variant order from the run and phase IDs', () => {
        const first = getVariantOrder('run-1', 'main');
        const second = getVariantOrder('run-1', 'main');
        const sorted = [...first].sort();

        expect(second).toEqual(first);
        expect(sorted).toEqual(['all-functions', 'control', 'named-only']);
    });

    test('should use every variant order across runs', () => {
        const orders = new Set<string>();
        for (let run = 0; run < 60; run++) {
            const order = getVariantOrder(`run-${run}`, 'main');
            orders.add(order.join(','));
        }

        expect(orders.size).toBe(6);
    });

    test('should measure raw and gzip bytes without double-counting overlapping roots', async () => {
        const nestedRoot = path.resolve(TEST_ROOT, 'output/nested');
        const firstPath = path.resolve(TEST_ROOT, 'output/first.js');
        const secondPath = path.resolve(nestedRoot, 'second.js');
        const firstContent = 'console.log("first");';
        const secondContent = 'console.log("second");';
        await outputFile(firstPath, firstContent);
        await outputFile(secondPath, secondContent);

        const measurement = await measureArtifacts({
            roots: [path.resolve(TEST_ROOT, 'output'), nestedRoot],
            patterns: ['**/*.js'],
        });
        const rawBytes = Buffer.byteLength(firstContent) + Buffer.byteLength(secondContent);
        const firstGzip = gzipSync(firstContent);
        const secondGzip = gzipSync(secondContent);
        const gzipBytes = firstGzip.length + secondGzip.length;

        expect(measurement).toEqual({
            fileCount: 2,
            filePaths: [firstPath, secondPath],
            gzipBytes,
            rawBytes,
        });
    });

    test('should run a non-Rspack phase, compare variants, write a report, and clean up', async () => {
        const controlPath = path.resolve(TEST_ROOT, 'control/app.js');
        const allFunctionsPath = path.resolve(TEST_ROOT, 'all-functions/app.js');
        const namedOnlyPath = path.resolve(TEST_ROOT, 'named-only/app.js');
        await outputFile(controlPath, 'function app() { return 1; }');
        await outputFile(allFunctionsPath, 'function app() { $dd_probes("app"); return 1; }');
        await outputFile(namedOnlyPath, 'function app() { $dd_probes("a"); return 1; }');

        const commands: string[] = [];
        const runCommand: RunCommand = async (spec) => {
            commands.push(spec.label);
            if (spec.label === 'build:control') {
                return successfulResult(100);
            }
            if (spec.label === 'build:all-functions') {
                return successfulResult(125);
            }
            if (spec.label === 'build:named-only') {
                return successfulResult(110);
            }
            return successfulResult(1);
        };
        const cleanupOrder: string[] = [];
        const target = createSyntheticTarget(TEST_ROOT, cleanupOrder);
        const reportPath = path.resolve(TEST_ROOT, 'report.json');
        const report = await runCanary({
            buildPluginsRoot: process.cwd(),
            phaseSelection: 'all',
            reportPath,
            root: TEST_ROOT,
            runCommand,
            runId: 'synthetic-run',
            target,
        });

        expect(report.status).toBe('passed');
        expect(report.phases[0]?.buildTool).toBe('webpack');
        expect(report.phases[0]?.comparisons['all-functions'].durationMs).toEqual({
            control: 100,
            instrumented: 125,
            delta: 25,
            deltaPercent: 25,
        });
        expect(report.phases[0]?.comparisons['named-only'].durationMs).toEqual({
            control: 100,
            instrumented: 110,
            delta: 10,
            deltaPercent: 10,
        });
        expect(report.phases[0]?.comparisons['named-only'].rawBytes.delta).toBe(
            Buffer.byteLength('$dd_probes("a"); '),
        );
        expect(commands).toHaveLength(6);
        expect(cleanupOrder).toEqual(['second', 'first']);
        const serialized = await readFile(reportPath);
        expect(serialized).toContain('"schemaVersion": 2');
        expect(serialized).toContain('"buildTool": "webpack"');
        expect(serialized).toContain('"dirty": true');
    });

    test('should write failure details and run cleanup in reverse order', async () => {
        const controlPath = path.resolve(TEST_ROOT, 'control/app.js');
        const allFunctionsPath = path.resolve(TEST_ROOT, 'all-functions/app.js');
        await outputFile(controlPath, 'control');
        await outputFile(allFunctionsPath, 'all-functions');

        const runCommand: RunCommand = async () => ({
            durationMs: 10,
            exitCode: 1,
            output: 'build failed',
            signal: null,
        });
        const cleanupOrder: string[] = [];
        const target = createSyntheticTarget(TEST_ROOT, cleanupOrder);
        const reportPath = path.resolve(TEST_ROOT, 'failed-report.json');
        const promise = runCanary({
            buildPluginsRoot: process.cwd(),
            phaseSelection: 'all',
            reportPath,
            root: TEST_ROOT,
            runCommand,
            runId: 'failed-run',
            target,
        });

        await expect(promise).rejects.toThrow('failed with exit code 1');
        expect(cleanupOrder).toEqual(['second', 'first']);
        const serialized = await readFile(reportPath);
        expect(serialized).toContain('"status": "failed"');
        expect(serialized).toContain('"stage": "phase:webpack-production"');
    });
});
