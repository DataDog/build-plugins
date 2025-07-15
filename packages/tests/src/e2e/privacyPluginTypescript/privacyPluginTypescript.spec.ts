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
};

describe('Privacy Plugin', () => {
    // Build our fixture project.
    beforeAll(async ({ publicDir, bundlers, suiteName }) => {
        const source = path.resolve(__dirname, 'project');
        const destination = path.resolve(publicDir, suiteName);
        await verifyProjectBuild(
            source,
            destination,
            bundlers.filter((bundler) => bundler !== 'webpack4'),
            {
                ...defaultConfig,
                rum: {
                    privacy: {
                        disabled: false,
                    },
                },
            },
            {
                entry: bundlers.reduce((acc, bundler) => ({ ...acc, [bundler]: './index.ts' }), {}),
                outDir: path.resolve(destination, 'dist'),
                workingDir: destination,
                plugins: [],
            },
        );
    });

    test('Should have set global variables in the helper', async ({
        page,
        bundler,
        browserName,
        suiteName,
        devServerUrl,
    }) => {
        if (bundler === 'webpack4') {
            // skip for webpack4 because ts-loader version conflict
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

        const ddAllow = await page.evaluate(() => {
            return Array.from((globalThis as any).$DD_ALLOW);
        });

        expect(ddAllow).toContain(`Hello, ${bundler}!`);
        expect(ddAllow).toContain('times repeatedly');
        expect(errors).toEqual([]);
    });
});
