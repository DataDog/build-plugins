// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync } from '@dd/core/helpers/fs';
import { verifyProjectBuild } from '@dd/tests/_playwright/helpers/buildProject';
import type { TestOptions } from '@dd/tests/_playwright/testParams';
import { test } from '@dd/tests/_playwright/testParams';
import { defaultConfig } from '@dd/tools/plugins';
import type { Page } from '@playwright/test';
import fs from 'fs/promises';
import JSZip from 'jszip';
import path from 'path';

const { expect, beforeAll, describe } = test;
let fixtureDestination = '';

const userFlow = async (url: string, page: Page, bundler: TestOptions['bundler']) => {
    // Navigate to our page. The context_bundler query param lets the dev server
    // substitute the {{bundler}} placeholder in the fixture's HTML/JS.
    await page.goto(`${url}/index.html?context_bundler=${bundler}`);
    await page.waitForSelector('body');
};

describe('Apps Plugin', () => {
    beforeAll(async ({ publicDir, bundlers, suiteName }) => {
        const source = path.resolve(__dirname, 'project');
        fixtureDestination = path.resolve(publicDir, suiteName);
        await verifyProjectBuild(source, fixtureDestination, bundlers, {
            ...defaultConfig,
            apps: {
                enable: true,
            },
        });
    });

    test('Should build and load the page without errors', async ({
        page,
        bundler,
        browserName,
        suiteName,
        devServerUrl,
    }) => {
        const errors: string[] = [];
        const testBaseUrl = `${devServerUrl}/${suiteName}`;
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('response', async (response) => {
            if (!response.ok()) {
                errors.push(
                    `[${bundler} ${browserName} ${response.status()}] ${response.request().url()}`,
                );
            }
        });
        const logs: string[] = [];
        page.on('console', async (message) => {
            if (message.type() === 'log') {
                for (const argument of message.args()) {
                    // eslint-disable-next-line no-await-in-loop
                    logs.push(await argument.jsonValue());
                }
            }
        });

        const bundleRequest = page.waitForResponse(`${testBaseUrl}/dist/${bundler}.js`);
        await userFlow(testBaseUrl, page, bundler);
        expect((await bundleRequest).ok()).toBe(true);
        expect(logs).toEqual([`Hello from apps plugin, ${bundler}!`]);
        expect(errors).toHaveLength(0);
    });

    test('Should write a Vite package without making an upload request', async ({ bundler }) => {
        if (bundler !== 'vite') {
            return;
        }
        const archivePath = path.join(fixtureDestination, 'dist', 'datadog-apps-assets.zip');
        expect(existsSync(archivePath)).toBe(true);

        // Validate the archive structure.
        const zip = await JSZip.loadAsync(await fs.readFile(archivePath));
        const files = Object.keys(zip.files);
        expect(files).toEqual(expect.arrayContaining(['manifest.json']));
        expect(files.some((file) => file.startsWith('frontend/'))).toBe(true);

        // Verify a backend function bundle is present and correctly wrapped.
        const greetFile = files.find(
            (file) => file.startsWith('backend/') && file.endsWith('.greet.js'),
        );
        expect(greetFile).toBeDefined();
        const greetContent = await zip.file(greetFile!)!.async('string');
        expect(greetContent).toContain('main');
        expect(greetContent).toContain('greet');

        // Verify the manifest maps the backend function correctly.
        const manifestContent = await zip.file('manifest.json')!.async('string');
        const manifest = JSON.parse(manifestContent);
        const greetName = greetFile!.replace(/^backend\//, '').replace(/\.js$/, '');
        expect(manifest).toEqual({
            backend: {
                functions: {
                    [greetName]: {
                        allowedConnectionIds: [],
                    },
                },
            },
        });

        // Generated package files must not be nested into the archive.
        expect(files).not.toEqual(expect.arrayContaining(['frontend/datadog-apps-assets.zip']));
    });
});
