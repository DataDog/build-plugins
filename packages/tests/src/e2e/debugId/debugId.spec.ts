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

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const userFlow = async (url: string, page: Page, bundler: TestOptions['bundler']) => {
    // Navigate to our page.
    await page.goto(`${url}/index.html?context_bundler=${bundler}`);
    await page.waitForSelector('body');
};

// Collect the debug_id values the injected snippet registered on the page.
const getDebugIds = async (page: Page): Promise<string[]> => {
    return page.evaluate(() => Object.values((globalThis as any)['DD_DEBUG_IDS'] || {}));
};

describe('Debug ID', () => {
    // Build our fixture project with debug_id injection enabled.
    beforeAll(async ({ publicDir, bundlers, suiteName }) => {
        const source = path.resolve(__dirname, 'project');
        const destination = path.resolve(publicDir, suiteName);
        await verifyProjectBuild(
            source,
            destination,
            bundlers,
            {
                ...defaultConfig,
                errorTracking: {
                    debugId: true,
                },
            },
            { splitting: true },
        );
    });

    test('Should register the entry debug_id on window.DD_DEBUG_IDS', async ({
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

        const debugIds = await getDebugIds(page);

        // The entry script registered at least one debug_id, and it is a valid UUID.
        expect(debugIds.length).toBeGreaterThanOrEqual(1);
        for (const debugId of debugIds) {
            expect(debugId).toMatch(UUID_RX);
        }
        expect(errors).toEqual([]);
    });

    test('Should register a distinct debug_id for a dynamically loaded chunk', async ({
        page,
        bundler,
        suiteName,
        devServerUrl,
    }) => {
        await userFlow(`${devServerUrl}/${suiteName}`, page, bundler);

        const before = await getDebugIds(page);

        // Loading a separate chunk evaluates its own injected snippet.
        await page.click('#load_chunk');
        await page.waitForFunction(() => window.chunkLoaded === true);

        const after = await getDebugIds(page);

        // The chunk contributed at least one new, distinct debug_id (per emitted file).
        expect(after.length).toBeGreaterThan(before.length);
        const newDebugIds = after.filter((debugId) => !before.includes(debugId));
        expect(newDebugIds.length).toBeGreaterThanOrEqual(1);
        for (const debugId of after) {
            expect(debugId).toMatch(UUID_RX);
        }
    });

    test('Should not throw errors', async ({ page, bundler, suiteName, devServerUrl }) => {
        const errors: string[] = [];
        const testBaseUrl = `${devServerUrl}/${suiteName}`;

        // Listen for errors on the page.
        page.on('pageerror', (error) => errors.push(error.message));

        // Mock error to confirm the snippet's try/catch swallows failures.
        await page.addInitScript(() => {
            (globalThis as any).Error = function () {
                // eslint-disable-next-line no-throw-literal
                throw 'Test error from debug id snippet';
            };
        });

        await userFlow(testBaseUrl, page, bundler);
        expect(errors).toEqual([]);
    });
});
