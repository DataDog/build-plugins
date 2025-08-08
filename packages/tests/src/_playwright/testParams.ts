// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { FULL_NAME_BUNDLERS } from '@dd/core/constants';
import type { BundlerFullName } from '@dd/core/types';
import { DEV_SERVER_URL, PUBLIC_DIR, RUM_API } from '@dd/tests/_playwright/constants';
import { test as base } from '@playwright/test';
import nock from 'nock';
import path from 'path';

export type TestOptions = {
    bundler: BundlerFullName;
    bundlers: BundlerFullName[];
};

type Fixtures = {
    devServerUrl: string;
    publicDir: string;
    suiteName: string;
};

// Do not send any HTTP requests.
nock.disableNetConnect();
// Mock the sourcemaps upload.
nock('https://sourcemap-intake.datadoghq.com').post('/api/v2/srcmap').reply(200, {}).persist();
// Mock the metrics submission.
nock('https://app.datadoghq.com').post('/api/v1/series?api_key=123').reply(200, {}).persist();

export const test = base.extend<TestOptions & Fixtures>({
    // Default value, will be overridden by config.
    bundler: ['rollup', { option: true }],
    bundlers: [[...FULL_NAME_BUNDLERS], { option: true }],
    devServerUrl: [
        // eslint-disable-next-line no-empty-pattern
        async ({}, use, info) => {
            const url = info.config.webServer?.url || DEV_SERVER_URL;
            await use(url);
        },
        { auto: true },
    ],
    suiteName: [
        // eslint-disable-next-line no-empty-pattern
        async ({}, use, info) => {
            await use(path.dirname(info.file).split(path.sep).pop() || 'unknown');
        },
        { auto: true },
    ],
    page: async ({ page }, use) => {
        // Mock the RUM API calls.
        await page.route(`**/*/${RUM_API}?*`, async (route) => route.fulfill({ status: 200 }));
        use(page);
    },
    publicDir: PUBLIC_DIR,
});
