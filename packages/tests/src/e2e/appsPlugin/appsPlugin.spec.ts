// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { verifyProjectBuild } from '@dd/tests/_playwright/helpers/buildProject';
import type { TestOptions } from '@dd/tests/_playwright/testParams';
import { test } from '@dd/tests/_playwright/testParams';
import { defaultConfig } from '@dd/tools/plugins';
import type { Page } from '@playwright/test';
import nock from 'nock';
import path from 'path';

// Have a similar experience to Jest.
const { expect, beforeAll, describe } = test;

const APP_IDENTIFIER = 'e2e-test-app-id';
const APP_NAME = 'e2e-test-app';

// Capture upload request details during the build.
let uploadRequest: {
    path: string;
    headers: Record<string, string>;
    body: string;
} | null = null;

// Mock the apps upload endpoint and capture the request.
nock('https://api.datadoghq.com')
    .post(new RegExp(`/api/unstable/app-builder-code/apps/.*/upload`))
    .reply(function (uri, body) {
        uploadRequest = {
            path: uri,
            headers: this.req.headers as Record<string, string>,
            body: typeof body === 'string' ? body : JSON.stringify(body),
        };
        return [
            200,
            {
                version_id: 'v-test-123',
                application_id: 'app-test-123',
                app_builder_id: 'builder-test-123',
            },
        ];
    })
    .persist();

const userFlow = async (url: string, page: Page, bundler: TestOptions['bundler']) => {
    // Navigate to our page.
    await page.goto(`${url}/index.html?context_bundler=${bundler}`);
    await page.waitForSelector('body');
};

describe('Apps Plugin', () => {
    // Build our fixture project with the apps plugin enabled and upload active.
    beforeAll(async ({ publicDir, bundlers, suiteName }) => {
        const source = path.resolve(__dirname, 'project');
        const destination = path.resolve(publicDir, suiteName);
        await verifyProjectBuild(source, destination, bundlers, {
            ...defaultConfig,
            apps: {
                enable: true,
                dryRun: false,
                identifier: APP_IDENTIFIER,
                name: APP_NAME,
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

        // Listen for errors on the page.
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('response', async (response) => {
            if (!response.ok()) {
                const url = response.request().url();
                const prefix = `[${bundler} ${browserName} ${response.status()}]`;
                errors.push(`${prefix} ${url}`);
            }
        });

        // Verify that we do log the expected things.
        const logs: string[] = [];
        page.on('console', async (msg) => {
            if (msg.type() !== 'log') {
                return;
            }
            for (const arg of msg.args()) {
                // eslint-disable-next-line no-await-in-loop
                logs.push(await arg.jsonValue());
            }
        });

        // It should load the correct bundler file.
        const bundleRequest = page.waitForResponse(`${testBaseUrl}/dist/${bundler}.js`);
        await userFlow(testBaseUrl, page, bundler);
        expect((await bundleRequest).ok()).toBe(true);

        expect(logs).toEqual([`Hello from apps plugin, ${bundler}!`]);
        expect(errors).toHaveLength(0);
    });

    test('Should have uploaded assets to the apps intake', async () => {
        // The upload happens during the build phase in beforeAll.
        expect(uploadRequest).not.toBeNull();

        // Verify the upload URL contains the app identifier.
        expect(uploadRequest!.path).toContain(
            `/api/unstable/app-builder-code/apps/${APP_IDENTIFIER}/upload`,
        );

        // Verify the origin headers are set.
        expect(uploadRequest!.headers['dd-evp-origin']).toMatch(/-build-plugin_apps$/);
        expect(uploadRequest!.headers['dd-evp-origin-version']).toBeDefined();

        // The body is hex-encoded multipart form data. Decode it to verify contents.
        const decodedBody = Buffer.from(uploadRequest!.body, 'hex').toString('utf-8');
        expect(decodedBody).toContain(APP_NAME);
        expect(decodedBody).toContain('datadog-apps-assets.zip');
    });
});
