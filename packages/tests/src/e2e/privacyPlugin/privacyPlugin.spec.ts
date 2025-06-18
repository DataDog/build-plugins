// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis */
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
};

describe('Privacy Plugin', () => {
    // Build our fixture project.
    beforeAll(async ({ publicDir, bundlers, suiteName }) => {
        const source = path.resolve(__dirname, 'project');
        const destination = path.resolve(publicDir, suiteName);
        await verifyProjectBuild(source, destination, bundlers);
    });

    test('Should have set global variables in the helper', async ({
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

        await userFlow(testBaseUrl, page, bundler);

        const ddAllow = await page.evaluate(() => {
            return (globalThis as any).$DD_ALLOW;
        });

        expect(ddAllow).toBeDefined();
        expect(errors).toEqual([]);
    });

    test('Should trigger the callback when new scripts are loaded', async ({
        page,
        bundler,
        browserName,
        suiteName,
        devServerUrl,
    }) => {
        // skip for webpack4 because of dynamic import
        if (bundler === 'webpack4') {
            test.skip();
        }

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

        await userFlow(testBaseUrl, page, bundler);

        await page.evaluate(() => {
            if ((globalThis as any).$DD_ALLOW_OBSERVERS) {
                console.log((globalThis as any).$DD_ALLOW_OBSERVERS.size);
                (globalThis as any).$DD_ALLOW_OBSERVERS.add(() => {
                    console.log('DD_ALLOW observer triggered');
                });
            } else {
                // fail the test
                expect(true).toBe(false);
            }
        });

        const button = page.getByTestId('load-script');
        const waitForLog = page.waitForEvent('console', (msg) =>
            msg.text().includes('DD_ALLOW observer triggered'),
        );
        await button.click();
        expect(await waitForLog).toBeTruthy();
    });
});
