// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { RUM_API } from '@dd/tests/_playwright/constants';
import { verifyProjectBuild } from '@dd/tests/_playwright/helpers/buildProject';
import type { TestOptions } from '@dd/tests/_playwright/testParams';
import { test } from '@dd/tests/_playwright/testParams';
import type { Page } from '@playwright/test';
import path from 'path';

// Have a similar experience to Jest.
const { expect, beforeAll, describe } = test;

const userFlow = async (url: string, page: Page, bundler: TestOptions['bundler']) => {
    // Navigate to our page.
    await page.goto(`${url}/index.html?context_bundler=${bundler}`);
    await page.waitForSelector('body');

    // Do some actions.
    await page.click('#click_btn');
};

describe('Browser SDK injection', () => {
    // Build our fixture project.
    beforeAll(async ({ publicDir, bundlers, suiteName }) => {
        const source = path.resolve(__dirname, 'project');
        const destination = path.resolve(publicDir, suiteName);
        await verifyProjectBuild(source, destination, bundlers);
    });

    test('Should load the page without errors', async ({
        page,
        bundler,
        browserName,
        suiteName,
        devServerUrl,
    }) => {
        const errors: string[] = [];
        const testBaseUrl = `${devServerUrl}/${suiteName}`;

        // Listen for errors on the page.
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('response', async (response) => {
            if (!response.ok()) {
                const url = response.request().url();
                const prefix = `[${bundler} ${browserName} ${response.status()}]`;
                errors.push(`${prefix} ${url}`);
            }
        });

        // It should load the correct bundler file too.
        const bundleRequest = page.waitForResponse(`${testBaseUrl}/dist/${bundler}.js`);
        await userFlow(testBaseUrl, page, bundler);
        expect((await bundleRequest).ok()).toBe(true);

        expect(errors).toHaveLength(0);
    });

    test('Should send the correct events to RUM', async ({
        page,
        bundler,
        devServerUrl,
        suiteName,
    }) => {
        const events: any[] = [];
        const testBaseUrl = `${devServerUrl}/${suiteName}`;

        // Intercept the RUM requests.
        page.on('request', (request) => {
            const url = request.url();
            if (!url.includes(RUM_API)) {
                return;
            }

            const data = request.postData();

            if (!data) {
                return;
            }

            // Format it as JSON and store it.
            const jsonString = `[${data.split(/\}[\s]*\{/).join('},{')}]`;
            events.push(...JSON.parse(jsonString));
        });

        // Wait for the flush response.
        const flushRequest = page.waitForResponse(new RegExp(RUM_API.replace(/\//g, '\\/')));
        await userFlow(testBaseUrl, page, bundler);
        expect((await flushRequest).ok()).toBe(true);

        // We do DD_RUM.setViewName('custom_view') in projects/index.js
        const missingViewName = events.filter(
            (event) => event.type !== 'telemetry' && event.view?.name !== 'custom_view',
        );
        expect(missingViewName).toHaveLength(0);

        // We do DD_RUM.addAction('custom_click', { bundler: '{{bundler}}' }) in projects/index.js
        const hasAction = events.some(
            (event) =>
                event.action?.target?.name === 'custom_click' && event.context.bundler === bundler,
        );
        expect(hasAction).toBe(true);
    });
});
