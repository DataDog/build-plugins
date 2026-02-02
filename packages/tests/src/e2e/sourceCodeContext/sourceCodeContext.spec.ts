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

const SERVICE_NAME = 'test-micro-frontend';
const SERVICE_VERSION = '1.2.3';

const userFlow = async (url: string, page: Page, bundler: TestOptions['bundler']) => {
    // Navigate to our page.
    await page.goto(`${url}/index.html?context_bundler=${bundler}`);
    await page.waitForSelector('body');
};

const getRUMEvents = async (page: Page) => {
    await page.evaluate(() => {
        (globalThis as any).DD_RUM.stopSession();
    });
    return page.evaluate(() => (globalThis as any).rum_events);
};

describe('Source Code Context', () => {
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
                    enable: true,
                    sourceCodeContext: {
                        service: SERVICE_NAME,
                        version: SERVICE_VERSION,
                    },
                },
            },
            { splitting: true },
        );
    });

    test('Should inject DD_SOURCE_CODE_CONTEXT global variable', async ({
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

        // Check that DD_SOURCE_CODE_CONTEXT is defined
        const hasContext = await page.evaluate(() => {
            return typeof (globalThis as any).DD_SOURCE_CODE_CONTEXT !== 'undefined';
        });

        expect(hasContext).toBe(true);
        expect(errors).toEqual([]);
    });

    test('Should not throw errors', async ({
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

        // Mock error to confirm the snippet’s try/catch blocks failures
        await page.addInitScript(() => {
            (globalThis as any).Error = function () {
                // eslint-disable-next-line no-throw-literal
                throw 'Test error from source code context';
            };
        });

        await userFlow(testBaseUrl, page, bundler);
        expect(errors).toEqual([]);
    });

    test('Should enrich RUM events with source code context (service/version)', async ({
        page,
        bundler,
        suiteName,
        devServerUrl,
    }) => {
        await userFlow(`${devServerUrl}/${suiteName}`, page, bundler);

        // Initialize RUM with beforeSend.
        await page.evaluate(() => {
            (globalThis as any).rum_events = [];
            (globalThis as any).DD_RUM.init({
                clientToken: '<CLIENT_TOKEN>',
                applicationId: '<APP_ID>',
                enableExperimentalFeatures: ['source_code_context'],
                beforeSend: (event: any) => {
                    (globalThis as any).rum_events.push(event);
                    return true;
                },
            });
        });

        await page.click('#load_chunk');
        await page.waitForFunction(() => window.chunkLoaded === true);
        // Only testing error events here. Integration tests covering all RUM event types
        // with source code context are maintained in the Browser SDK repository to avoid duplication.
        await page.click('#trigger_entry_error');
        await page.click('#trigger_chunk_error');

        const events = await getRUMEvents(page);

        const predicate = (message: string) => (event: any) =>
            event.type === 'error' && event.error.message === message;
        const entryError = events.find(predicate('entry_error'));
        const chunkError = events.find(predicate('chunk_error'));

        expect(entryError).toMatchObject({ version: SERVICE_VERSION, service: SERVICE_NAME });
        expect(chunkError).toMatchObject({ version: SERVICE_VERSION, service: SERVICE_NAME });
    });
});
