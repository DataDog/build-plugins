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

    describe('RUM events enrichment', () => {
        async function setupEnrichmentTest(
            page: Page,
            devServerUrl: string,
            suiteName: string,
            bundler: 'webpack' | 'vite' | 'esbuild' | 'rollup' | 'rspack',
        ) {
            // Ensure all fake external calls succeed so the SDK can generate resource events.
            await page.route(/^https:\/\/fakeurl\.com\/.*/, async (route) => {
                await route.fulfill({ status: 200 });
            });

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
        }

        async function getRUMEvents(page: Page) {
            await page.evaluate(() => {
                (globalThis as any).DD_RUM.stopSession();
            });
            return page.evaluate(() => (globalThis as any).rum_events);
        }

        test('Should enrich RUM errors with source code context (service/version)', async ({
            page,
            bundler,
            suiteName,
            devServerUrl,
        }) => {
            await setupEnrichmentTest(page, devServerUrl, suiteName, bundler);

            await page.click('#trigger_entry_error');
            await page.click('#trigger_chunk_error');

            const events = await getRUMEvents(page);
            console.log(events);

            const predicate = (message: string) => (event: any) =>
                event.type === 'error' && event.error.message === message;
            const entryError = events.find(predicate('entry_error'));
            const chunkError = events.find(predicate('chunk_error'));

            expect(entryError).toMatchObject({ version: SERVICE_VERSION, service: SERVICE_NAME });
            expect(chunkError).toMatchObject({ version: SERVICE_VERSION, service: SERVICE_NAME });
        });

        test('Should enrich RUM actions with source code context (service/version)', async ({
            page,
            bundler,
            suiteName,
            devServerUrl,
        }) => {
            await setupEnrichmentTest(page, devServerUrl, suiteName, bundler);

            await page.click('#trigger_entry_action');
            await page.click('#trigger_chunk_action');

            const events = await getRUMEvents(page);
            console.log(
                events
                    .filter((event: any) => event.type === 'action')
                    .map((event: any) => event.action.target),
            );

            const predicate = (name: string) => (event: any) =>
                event.type === 'action' && event.action.target.name === name;
            const entryAction = events.find(predicate('entry_action'));
            const chunkAction = events.find(predicate('chunk_action'));

            expect(entryAction).toMatchObject({ version: SERVICE_VERSION, service: SERVICE_NAME });
            expect(chunkAction).toMatchObject({ version: SERVICE_VERSION, service: SERVICE_NAME });
        });

        test('Should enrich RUM fetch resources with source code context (service/version)', async ({
            page,
            bundler,
            suiteName,
            devServerUrl,
        }) => {
            await setupEnrichmentTest(page, devServerUrl, suiteName, bundler);

            await page.click('#trigger_entry_fetch');
            await page.click('#trigger_chunk_fetch');

            await page.waitForTimeout(100);
            const events = await getRUMEvents(page);
            console.log(events);

            const predicate = (url: string) => (event: any) =>
                event.type === 'resource' &&
                event.resource.type === 'fetch' &&
                event.resource.url.includes(url);
            const entryFetch = events.find(predicate('entry_fetch'));
            const chunkFetch = events.find(predicate('chunk_fetch'));

            expect(entryFetch).toMatchObject({ version: SERVICE_VERSION, service: SERVICE_NAME });
            expect(chunkFetch).toMatchObject({ version: SERVICE_VERSION, service: SERVICE_NAME });
        });

        test('Should enrich RUM XHR resources with source code context (service/version)', async ({
            page,
            bundler,
            suiteName,
            devServerUrl,
        }) => {
            await setupEnrichmentTest(page, devServerUrl, suiteName, bundler);
            await page.click('#trigger_entry_xhr');
            await page.click('#trigger_chunk_xhr');

            await page.waitForTimeout(100);
            const events = await getRUMEvents(page);
            console.log(
                events
                    .filter((event: any) => event.type === 'resource')
                    .map((event: any) => event.resource),
            );

            const predicate = (url: string) => (event: any) =>
                event.type === 'resource' &&
                event.resource.type === 'xhr' &&
                event.resource.url.includes(url);

            const entryXhr = events.find(predicate('entry_xhr'));
            const chunkXhr = events.find(predicate('chunk_xhr'));

            expect(entryXhr).toMatchObject({ version: SERVICE_VERSION, service: SERVICE_NAME });
            expect(chunkXhr).toMatchObject({ version: SERVICE_VERSION, service: SERVICE_NAME });
        });

        test('Should enrich RUM LOAf with source code context (service/version)', async ({
            page,
            bundler,
            browserName,
            suiteName,
            devServerUrl,
        }) => {
            test.skip(
                browserName !== 'chromium',
                'Non-Chromium browsers do not support long tasks',
            );

            await setupEnrichmentTest(page, devServerUrl, suiteName, bundler);

            await page.click('#trigger_entry_loaf');
            await page.click('#trigger_chunk_loaf');

            const events = await getRUMEvents(page);
            console.log(events);
            const predicate = (invoker: string) => (event: any) =>
                event.type === 'long_task' &&
                event.long_task.entry_type === 'long-animation-frame' &&
                event.long_task.scripts?.[0]?.invoker?.includes(invoker);
            const entryLoaf = events.find(predicate('BUTTON#trigger_entry_loaf.onclick'));
            const chunkLoaf = events.find(predicate('BUTTON#trigger_chunk_loaf.onclick'));

            expect(entryLoaf).toMatchObject({ version: SERVICE_VERSION, service: SERVICE_NAME });
            expect(chunkLoaf).toMatchObject({ version: SERVICE_VERSION, service: SERVICE_NAME });
        });
    });
});
