// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis */
import { existsSync, mkdir, outputFile, rm } from '@dd/core/helpers/fs';
import { verifyProjectBuild } from '@dd/tests/_playwright/helpers/buildProject';
import type { TestOptions } from '@dd/tests/_playwright/testParams';
import { test } from '@dd/tests/_playwright/testParams';
import { defaultConfig } from '@dd/tools/plugins';
import type { Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import { getLiveDebuggerBenchConfig } from './liveDebuggerBenchConfig';
import type { BenchVariant, BrowserBenchApi } from './types';

/* eslint-disable no-var, vars-on-top */
declare global {
    var ddBench: Record<BenchVariant, BrowserBenchApi> | undefined;
    var ddActiveProbes: Record<string, unknown[] | undefined>;
    var crossOriginIsolated: boolean;
    var $dd_probes: (functionId: string) => unknown[] | undefined;
    var $dd_entry: (probes: unknown[], self: unknown, args?: Record<string, unknown>) => void;
    var $dd_return: (
        probes: unknown[],
        value: unknown,
        self: unknown,
        args?: Record<string, unknown>,
        locals?: Record<string, unknown>,
    ) => unknown;
    var $dd_throw: (
        probes: unknown[],
        error: unknown,
        self: unknown,
        args?: Record<string, unknown>,
    ) => void;
}
/* eslint-enable no-var, vars-on-top */

const { expect, beforeAll, describe } = test;

const BENCH_OPTIONS = {
    calibrationAttempts: 8,
    minBatchMs: 50,
    warmupMs: process.env.CI ? 250 : 300,
};

const copyFixtureShell = async (source: string, destination: string) => {
    await fs.promises.cp(`${source}/`, `${destination}/`, {
        recursive: true,
        force: true,
    });
};

// Build baseline and instrumented variants separately, then serve their dist outputs
// from one fixture root so both bundles run back-to-back in the same browser page.
const buildVariant = async (
    source: string,
    rootDestination: string,
    variant: BenchVariant,
    bundlers: TestOptions['bundlers'],
) => {
    const variantDestination = path.resolve(rootDestination, variant);
    const enableLiveDebugger = variant === 'instrumented';
    const entry = `./${variant}.js`;

    await verifyProjectBuild(
        source,
        variantDestination,
        bundlers,
        {
            ...defaultConfig,
            liveDebugger: getLiveDebuggerBenchConfig(enableLiveDebugger),
        },
        {
            entry: {
                webpack: entry,
                vite: entry,
                esbuild: entry,
                rollup: entry,
                rspack: entry,
            },
        },
    );

    const sourceDist = path.resolve(variantDestination, 'dist');
    if (!existsSync(sourceDist)) {
        throw new Error(`Live Debugger benchmark ${variant} build did not produce ${sourceDist}`);
    }

    const destinationDist = path.resolve(rootDestination, 'dist', variant);
    await rm(destinationDist);
    await mkdir(path.dirname(destinationDist));
    await fs.promises.rename(sourceDist, destinationDist);
    await rm(variantDestination);
};

const buildBenchProject = async (
    source: string,
    destination: string,
    bundlers: TestOptions['bundlers'],
) => {
    if (existsSync(path.resolve(destination, 'built'))) {
        return;
    }

    try {
        await rm(destination);
        await copyFixtureShell(source, destination);
        await buildVariant(source, destination, 'baseline', bundlers);
        await buildVariant(source, destination, 'instrumented', bundlers);
        await outputFile(path.resolve(destination, 'built'), '');
    } catch (error) {
        await rm(destination);
        throw error;
    }
};

const userFlow = async (url: string, page: Page, bundler: TestOptions['bundler']) => {
    await page.goto(`${url}/index.html?context_bundler=${bundler}`);
    await page.waitForSelector('#status');
    await page.waitForFunction(() => {
        const bench = globalThis.ddBench;

        return Boolean(bench?.baseline && bench.instrumented);
    });

    return page.evaluate(() => {
        return globalThis.crossOriginIsolated;
    });
};

const installDormantDebuggerSdkHooks = async (page: Page) => {
    await page.addInitScript(() => {
        globalThis.ddActiveProbes = {
            // Mirror the Browser SDK by adding a __placeholder__ key.
            __placeholder__: undefined,
        };
        globalThis.$dd_probes = (functionId) => globalThis.ddActiveProbes[functionId];
        globalThis.$dd_entry = () => {};
        globalThis.$dd_return = (_probes, value) => value;
        globalThis.$dd_throw = () => {};
    });
};

describe('Live Debugger Runtime Benchmark', () => {
    beforeAll(async ({ publicDir, bundlers, suiteName }) => {
        const source = path.resolve(__dirname, 'project');
        const destination = path.resolve(publicDir, suiteName);
        await buildBenchProject(source, destination, bundlers);
    });

    test('Measures SDK-loaded dormant runtime overhead', async ({
        page,
        bundler,
        browserName,
        suiteName,
        devServerUrl,
    }, testInfo) => {
        const errors: string[] = [];
        const projectName = testInfo.project.name;
        const testBaseUrl = `${devServerUrl}/${suiteName}`;

        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (msg) => {
            if (msg.type() === 'error') {
                errors.push(`[console error] ${msg.text()}`);
            }
        });
        page.on('response', async (response) => {
            if (!response.ok()) {
                const url = response.request().url();
                const prefix = `[${browserName} ${response.status()}]`;
                errors.push(`${prefix} ${url}`);
            }
        });

        await installDormantDebuggerSdkHooks(page);

        const crossOriginIsolated = await userFlow(testBaseUrl, page, bundler);
        expect(crossOriginIsolated).toBe(true);

        const results = await page.evaluate((options) => {
            const bench = globalThis.ddBench;
            if (!bench) {
                throw new Error('Missing benchmark globals');
            }

            return bench.baseline.workloads.map((workload) => {
                const baseline = bench.baseline.workloads.find(
                    (candidate) => candidate.id === workload.id,
                );
                const instrumented = bench.instrumented.workloads.find(
                    (candidate) => candidate.id === workload.id,
                );

                if (!baseline || !instrumented) {
                    throw new Error(`Missing benchmark workload: ${workload.id}`);
                }

                return bench.baseline.runBenchPair(
                    workload,
                    [
                        { id: 'baseline', fn: baseline.fn },
                        { id: 'control', fn: baseline.fn },
                        { id: 'instrumented', fn: instrumented.fn },
                    ],
                    {
                        ...options,
                        batchSize: workload.batchSize,
                        samples: workload.samples,
                    },
                );
            });
        }, BENCH_OPTIONS);

        await testInfo.attach('live-debugger-runtime-bench', {
            body: JSON.stringify(
                {
                    browserName: projectName || browserName,
                    results,
                },
                null,
                2,
            ),
            contentType: 'application/json',
        });

        expect(results).toHaveLength(2);
        expect(errors).toEqual([]);
    });
});
