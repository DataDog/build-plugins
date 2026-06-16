// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis */
import type { BundlerName } from '@dd/core/types';
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

// Collect the debug_id values from DD_SOURCE_CODE_CONTEXT entries.
const getDebugIds = async (page: Page): Promise<string[]> => {
    return page.evaluate(() =>
        Object.values((globalThis as any)['DD_SOURCE_CODE_CONTEXT'] || {})
            .map((ctx: unknown) => (ctx as Record<string, unknown>)?.ddDebugId)
            .filter((id: unknown): id is string => typeof id === 'string'),
    );
};

async function build(publicDir: string, suiteName: string, bundlers: BundlerName[]) {
    const source = path.resolve(__dirname, 'project');
    const destination = path.resolve(publicDir, suiteName);
    await verifyProjectBuild(
        source,
        destination,
        bundlers,
        {
            ...defaultConfig,
            rum: {
                sourceCodeContext: {
                    debugId: true,
                },
            },
        },
        { splitting: true },
    );
}

describe('Debug ID', () => {
    // Build our fixture project with debug_id injection enabled.
    beforeAll(async ({ publicDir, bundlers, suiteName }) => {
        await build(publicDir, suiteName, bundlers);
    });

    test('Should register the entry debug_id on window.DD_SOURCE_CODE_CONTEXT', async ({
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

    test('Should generate the same debug_id across two builds', async ({
        page,
        bundler,
        suiteName,
        devServerUrl,
        publicDir,
        bundlers,
    }) => {
        // rspack chunk.contentHash.javascript is non-deterministic across builds when devtool
        // is enabled, causing different debug IDs each time.
        test.skip(
            bundler === 'rspack',
            'rspack content hash is not deterministic across build directories when devtool is enabled',
        );

        await build(publicDir, `${suiteName}-rebuild`, bundlers);

        await userFlow(`${devServerUrl}/${suiteName}`, page, bundler);
        const firstBuildIds = await getDebugIds(page);

        await userFlow(`${devServerUrl}/${suiteName}-rebuild`, page, bundler);
        const secondBuildIds = await getDebugIds(page);

        expect(firstBuildIds.sort()).toEqual(secondBuildIds.sort());
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
