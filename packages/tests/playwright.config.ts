// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { SUPPORTED_BUNDLERS } from '@dd/core/constants';
import { DEV_SERVER_PORT, DEV_SERVER_URL, PUBLIC_DIR } from '@dd/tests/_playwright/constants';
import { getRequestedBundlers } from '@dd/tests/_playwright/helpers/requestedBundlers';
import type { TestOptions } from '@dd/tests/_playwright/testParams';
import { ROOT } from '@dd/tools/constants';
import { defineConfig, devices } from '@playwright/test';

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig<TestOptions>({
    testDir: './src/e2e',
    /* Run tests in files in parallel */
    fullyParallel: true,
    /* Fail the build on CI if you accidentally left test.only in the source code. */
    forbidOnly: !!process.env.CI,
    /* Retry on CI only */
    retries: process.env.CI ? 2 : 0,
    /* Reporter to use. See https://playwright.dev/docs/test-reporters */
    reporter: process.env.CI ? 'html' : 'list',
    /* Path to file run before all the tests. See https://playwright.dev/docs/test-global-setup-teardown */
    globalSetup: require.resolve('./src/_playwright/globalSetup.ts'),
    use: {
        bundlers: getRequestedBundlers(),
        trace: 'retain-on-failure',
    },
    globalTimeout: process.env.CI ? 20 * 60 * 1000 : undefined,
    timeout: 60_000,
    /* Configure projects for each bundler */
    // TODO Also build and test for ESM.
    projects: SUPPORTED_BUNDLERS.map((bundler) => [
        {
            name: `chrome | ${bundler}`,
            use: {
                ...devices['Desktop Chrome'],
                bundler,
            },
        },
        {
            name: `firefox | ${bundler}`,
            use: {
                ...devices['Desktop Firefox'],
                bundler,
            },
        },
        {
            name: `edge | ${bundler}`,
            use: {
                ...devices['Desktop Edge'],
                bundler,
            },
        },
        {
            name: `safari | ${bundler}`,
            use: {
                ...devices['Desktop Safari'],
                bundler,
            },
        },
    ]).flat(),

    /* Run your local dev server before starting the tests */
    webServer: {
        command: `yarn cli dev-server --root=${PUBLIC_DIR} --port=${DEV_SERVER_PORT}`,
        cwd: ROOT,
        url: DEV_SERVER_URL,
        reuseExistingServer: !process.env.CI,
    },
});
