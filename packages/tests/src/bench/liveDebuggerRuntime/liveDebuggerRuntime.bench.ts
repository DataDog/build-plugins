// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis */
import { existsSync, mkdir, outputFile, rm } from '@dd/core/helpers/fs';
import { doRequest } from '@dd/core/helpers/request';
import { verifyProjectBuild } from '@dd/tests/_playwright/helpers/buildProject';
import type { TestOptions } from '@dd/tests/_playwright/testParams';
import { test } from '@dd/tests/_playwright/testParams';
import { defaultConfig } from '@dd/tools/plugins';
import type { Page } from '@playwright/test';
import fs from 'fs';
import nock from 'nock';
import path from 'path';

import { getLiveDebuggerBenchConfig } from './liveDebuggerBenchConfig';
import { normalizeEtag } from './reporter/benchReporter';
import type { BenchVariant, BrowserBenchApi, SdkBuild } from './types';

/* eslint-disable no-var, vars-on-top */
declare global {
    var ddBench: Record<BenchVariant, BrowserBenchApi> | undefined;
    var crossOriginIsolated: boolean;
    var $dd_probes: (functionId: string) => unknown[] | undefined;
    var DD_DEBUGGER:
        | {
              version: string;
              init: (configuration: {
                  clientToken: string;
                  service: string;
                  site?: string;
                  proxy?: string;
                  pollInterval?: number;
              }) => void;
          }
        | undefined;
}
/* eslint-enable no-var, vars-on-top */

const { expect, beforeAll, describe } = test;

const BENCH_OPTIONS = {
    calibrationAttempts: 8,
    minBatchMs: 50,
    warmupMs: process.env.CI ? 250 : 300,
};

// The Browser Debugger SDK is published to the CDN on every commit to master, so the
// benchmark exercises the real, shipped $dd_probes / $dd_entry / $dd_return / $dd_throw
// instead of a hand-written stub that could silently drift from the SDK.
const SDK_BUNDLE_URL = 'https://www.datadoghq-browser-agent.com/us1/v7/datadog-debugger.js';
// Cache the vendored SDK bundle under the build's dist/ folder so it inherits the repo's
// ignore rules for build output (it is minified and must not be linted or committed).
const SDK_BUNDLE_RELATIVE_PATH = path.join('dist', 'datadog-debugger.cdn.js');
// Probe-delivery endpoint the SDK polls, hardcoded in the SDK's delivery API.
const DEBUGGER_PROBES_PATH = '/api/unstable/debugger/frontend/probes';

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

// Fetch the published Browser Debugger SDK bundle and cache it on disk so it can be
// injected into the benchmark page. Fetched fresh per run so the benchmark always tracks
// the SDK that is actually shipping; the bundle only provides the real runtime hooks and
// never participates in the measured hot path.
const ensureDebuggerSdkBundle = async (bundlePath: string): Promise<SdkBuild> => {
    // The bench test process runs with nock.disableNetConnect() (see _playwright/testParams),
    // so briefly allow the CDN host, fetch the bundle, then restore the global block.
    const sdkHostname = new URL(SDK_BUNDLE_URL).hostname;
    nock.enableNetConnect(sdkHostname);
    // Hold onto the response headers so we can derive the CDN object's build fingerprint, which
    // pins the exact published build behind the (ambiguous) baked SDK version.
    let responseHeaders: Headers | undefined;
    try {
        const bundle = await doRequest<string>({
            url: SDK_BUNDLE_URL,
            type: 'text',
            retries: 3,
            onResponse: (response) => {
                responseHeaders = response.headers;
            },
        });
        if (!bundle.includes('DD_DEBUGGER')) {
            throw new Error(`Fetched Browser Debugger SDK from ${SDK_BUNDLE_URL} looks invalid`);
        }
        await outputFile(bundlePath, bundle);
    } finally {
        nock.disableNetConnect();
    }

    // The CDN (S3/CloudFront) always returns these for the bundle object, and the fingerprint is
    // required provenance, so a missing header means the URL or infra changed: fail loudly rather
    // than record a build we cannot identify (mirroring how the SDK version is asserted).
    if (!responseHeaders) {
        throw new Error(
            `No response captured while fetching the Browser Debugger SDK from ${SDK_BUNDLE_URL}`,
        );
    }
    const lastModified = responseHeaders.get('last-modified');
    const publishedAt = lastModified ? new Date(lastModified) : undefined;
    if (!publishedAt || Number.isNaN(publishedAt.getTime())) {
        throw new Error(
            `Browser Debugger SDK response is missing a valid Last-Modified header (${SDK_BUNDLE_URL})`,
        );
    }
    const etag = responseHeaders.get('etag');
    if (!etag) {
        throw new Error(
            `Browser Debugger SDK response is missing an ETag header (${SDK_BUNDLE_URL})`,
        );
    }
    return {
        publishedAt: publishedAt.toISOString(),
        etag: normalizeEtag(etag),
    };
};

// Vendor the real Browser Debugger SDK into the page: mock its only dormant egress (the
// probe-delivery poll, matched by path) and inline the CDN bundle so window.DD_DEBUGGER
// exists before any page script. The mocked poll returns an empty probe set, which keeps the
// SDK dormant (no active probes) for the whole benchmark.
const installRealDebuggerSdk = async (page: Page, bundlePath: string) => {
    await page.route(`**${DEBUGGER_PROBES_PATH}`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ nextCursor: '', updates: [], deletions: [] }),
        });
    });

    // The bundle makes no network calls at load (only init() polls), so inlining it at
    // document_start is safe and defines window.DD_DEBUGGER for initRealDebuggerSdk to use.
    await page.addInitScript({ path: bundlePath });
};

// Initialize the real SDK dormant (no active probes), wiring the production $dd_probes /
// $dd_entry / $dd_return / $dd_throw. Called after the page has loaded rather than from a
// document_start init script: init() starts the probe-delivery poll, and a fetch fired that
// early escapes Playwright route interception in Firefox (it hits the network and the SDK
// logs a "Delivery API poll error"). Initializing post-load fires the poll while interception
// is reliably active in every browser. `proxyOrigin` is the page origin, keeping the poll
// same-origin (no CORS preflight). The instrumented workloads only run later (in
// runBenchPair), so $dd_probes is the real getProbes for every measured call even though init
// happens after the bundle's bootstrap stub.
const initRealDebuggerSdk = async (page: Page, proxyOrigin: string) => {
    await page.evaluate((proxy) => {
        globalThis.DD_DEBUGGER?.init({
            clientToken: 'pub00000000000000000000000000000000',
            service: 'live-debugger-runtime-bench',
            site: 'datadoghq.com',
            proxy,
            // One day: only the initial poll fires, avoiding re-poll noise mid-measurement.
            pollInterval: 24 * 60 * 60 * 1000,
        });
    }, proxyOrigin);
};

describe('Live Debugger Runtime Benchmark', () => {
    // Build fingerprint of the CDN bundle fetched for this run, captured once in beforeAll
    // and attached to each test so the reporter can pin the exact measured build.
    let sdkBuild: SdkBuild | undefined;

    beforeAll(async ({ publicDir, bundlers, suiteName }) => {
        const source = path.resolve(__dirname, 'project');
        const destination = path.resolve(publicDir, suiteName);
        await buildBenchProject(source, destination, bundlers);
        const bundlePath = path.resolve(destination, SDK_BUNDLE_RELATIVE_PATH);
        sdkBuild = await ensureDebuggerSdkBundle(bundlePath);
    });

    test('Measures SDK-loaded dormant runtime overhead', async ({
        page,
        bundler,
        browserName,
        suiteName,
        devServerUrl,
        publicDir,
    }, testInfo) => {
        const errors: string[] = [];
        const projectName = testInfo.project.name;
        const testBaseUrl = `${devServerUrl}/${suiteName}`;
        const bundlePath = path.resolve(publicDir, suiteName, SDK_BUNDLE_RELATIVE_PATH);

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

        // Mock the SDK's probe poll and inline the real CDN bundle before navigation.
        await installRealDebuggerSdk(page, bundlePath);

        const crossOriginIsolated = await userFlow(testBaseUrl, page, bundler);
        expect(crossOriginIsolated).toBe(true);

        // Initialize the SDK now that the page is loaded, then wait for its (mocked) probe
        // poll so the registry has settled (empty) before measuring. `devServerUrl` is the
        // page origin, keeping the poll same-origin.
        const probePoll = page.waitForResponse((response) =>
            response.url().includes(DEBUGGER_PROBES_PATH),
        );
        await initRealDebuggerSdk(page, devServerUrl);
        await probePoll;

        // Confirm the real SDK loaded and is dormant (no active probes) before measuring.
        const sdkState = await page.evaluate(() => {
            const probesForAbsentFunction = globalThis.$dd_probes(
                'live-debugger-runtime-bench;__absent__',
            );
            return {
                hasSdk: typeof globalThis.DD_DEBUGGER !== 'undefined',
                version: globalThis.DD_DEBUGGER?.version,
                dormant: probesForAbsentFunction === undefined,
            };
        });
        expect(sdkState.hasSdk).toBe(true);
        expect(sdkState.dormant).toBe(true);

        // The SDK always exposes its build version (set by makePublicApi). A missing version
        // means the SDK failed to load or changed its contract, so fail loudly here rather
        // than silently reporting an "unknown" version downstream.
        const sdkVersion = sdkState.version;
        if (!sdkVersion) {
            throw new Error('Browser Debugger SDK did not expose a version');
        }

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

        if (!sdkBuild) {
            throw new Error('Browser Debugger SDK build fingerprint was not captured in beforeAll');
        }

        await testInfo.attach('live-debugger-runtime-bench', {
            body: JSON.stringify(
                {
                    browserName: projectName || browserName,
                    sdkVersion,
                    sdkBuild,
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
