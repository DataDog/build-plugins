// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis */
import { verifyProjectBuild } from '@dd/tests/_playwright/helpers/buildProject';
import type { TestOptions } from '@dd/tests/_playwright/testParams';
import { test } from '@dd/tests/_playwright/testParams';
import { defaultConfig } from '@dd/tools/plugins';
import type { Page } from '@playwright/test';
import path from 'path';

// Have a similar experience to Jest.
const { expect, beforeAll, describe } = test;

const userFlow = async (url: string, page: Page, bundler: TestOptions['bundler']) => {
    // Navigate to our page.
    await page.goto(`${url}/index.html?context_bundler=${bundler}`);
    await page.waitForSelector('body');
    
    // Click the test button to trigger circular imports
    await page.click('#testButton');
    await page.waitForSelector('#output');
};

describe('Privacy Plugin with Circular Imports', () => {
    // Build our fixture project.
    beforeAll(async ({ publicDir, bundlers, suiteName }) => {
        const source = path.resolve(__dirname, 'project');
        const destination = path.resolve(publicDir, suiteName);
        await verifyProjectBuild(
            source,
            destination,
            bundlers,
            {
                ...defaultConfig,
                rum: {
                    // enable:false,
                    privacy: {},
                },
            },
            {
                entry: bundlers.reduce((acc, bundler) => ({ ...acc, [bundler]: './index.ts' }), {}),
            },
        );
    });

    test('Should handle circular imports with privacy plugin', async ({
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

        // Check if the output is present and contains the expected value
        const outputText = await page.textContent('#output');
        expect(outputText).toContain('Final result:');

        // Verify privacy plugin functionality
        const ddAllow = await page.evaluate(() => {
            if((globalThis as any).$DD_ALLOW) {
                return Array.from((globalThis as any).$DD_ALLOW);
            }
            return [];
        });

        // Check for expected log messages in ddAllow
        expect(ddAllow).toContain(`hello, ${bundler}!`);
        expect(ddAllow).toContain('starting process in module a');
        expect(ddAllow).toContain('counter incremented ');
        expect(ddAllow).toContain('module a processed value: ');
        
        // Verify no errors occurred during the test
        expect(errors).toEqual([]);
    });
});
