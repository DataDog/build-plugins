// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { PUBLIC_DIR } from '@dd/tests/_playwright/constants';
import type { TestOptions } from '@dd/tests/_playwright/testParams';
import { ROOT } from '@dd/tools/constants';
import { defineConfig, devices } from '@playwright/test';

const BENCH_BUNDLER = 'rspack';
const BENCH_DEV_SERVER_PORT = 8001;
const BENCH_DEV_SERVER_URL = `http://localhost:${BENCH_DEV_SERVER_PORT}`;
const BENCH_BROWSERS = ['chrome', 'firefox', 'safari'] as const;

const DEVICE_BY_BROWSER = {
    chrome: devices['Desktop Chrome'],
    firefox: devices['Desktop Firefox'],
    safari: devices['Desktop Safari'],
};

/**
 * Live Debugger runtime benchmarks are opt-in and intentionally live outside
 * src/e2e so the normal E2E run does not collect noisy performance data.
 */
export default defineConfig<TestOptions>({
    testDir: './src/bench/liveDebuggerRuntime',
    testMatch: '**/*.bench.ts',
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: [['list'], ['./src/bench/liveDebuggerRuntime/reporter/benchReporter.ts']],
    globalSetup: require.resolve('./src/_playwright/globalSetup.ts'),
    use: {
        bundlers: [BENCH_BUNDLER],
        trace: 'off',
    },
    globalTimeout: process.env.CI ? 20 * 60 * 1000 : undefined,
    timeout: 120_000,
    projects: BENCH_BROWSERS.map((browserName) => ({
        name: browserName,
        use: {
            ...DEVICE_BY_BROWSER[browserName],
            bundler: BENCH_BUNDLER,
        },
    })),
    webServer: {
        command: `yarn cli dev-server --root=${PUBLIC_DIR} --port=${BENCH_DEV_SERVER_PORT} --cross-origin-isolated`,
        cwd: ROOT,
        url: BENCH_DEV_SERVER_URL,
        reuseExistingServer: !process.env.CI,
    },
});
