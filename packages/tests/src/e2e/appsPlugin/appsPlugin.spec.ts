// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, outputJsonSync, readJsonSync } from '@dd/core/helpers/fs';
import { verifyProjectBuild } from '@dd/tests/_playwright/helpers/buildProject';
import type { TestOptions } from '@dd/tests/_playwright/testParams';
import { test } from '@dd/tests/_playwright/testParams';
import { defaultConfig } from '@dd/tools/plugins';
import type { Page } from '@playwright/test';
import JSZip from 'jszip';
import nock from 'nock';
import os from 'os';
import path from 'path';

// Have a similar experience to Jest.
const { expect, beforeAll, describe } = test;

const APP_IDENTIFIER = 'e2e-test-app-id';
const APP_NAME = 'e2e-test-app';
const CAPTURE_DIR = path.join(os.tmpdir(), 'dd-e2e-apps-plugin');

type UploadRequest = {
    path: string;
    headers: Record<string, string>;
    body: string;
};

// Mock the apps upload endpoint and persist per-bundler upload data to disk.
// We write to a temp directory because Playwright workers are separate processes —
// only the worker that actually builds captures the nock request.
nock('https://api.datadoghq.com')
    .post(new RegExp(`/api/unstable/app-builder-code/apps/.*/upload`))
    .reply(function handleUploadMock(uri, body) {
        const data: UploadRequest = {
            path: uri,
            headers: this.req.headers as Record<string, string>,
            body: typeof body === 'string' ? body : JSON.stringify(body),
        };
        // Extract bundler name from the origin header (e.g. "rollup-build-plugin_apps").
        const origin = (this.req.headers['dd-evp-origin'] as string) || '';
        const bundlerName = origin.replace(/-build-plugin_apps$/, '');
        if (bundlerName) {
            outputJsonSync(path.join(CAPTURE_DIR, `upload-${bundlerName}.json`), data);
        }
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

// Read the persisted upload request data for a specific bundler.
const readUploadRequest = (bundler: string): UploadRequest | null => {
    const filePath = path.join(CAPTURE_DIR, `upload-${bundler}.json`);
    if (!existsSync(filePath)) {
        return null;
    }
    return readJsonSync(filePath) as UploadRequest;
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
                // Use absolute path because context.buildRoot is process.cwd() at plugin
                // init time, not the project directory.
                backendDir: path.resolve(__dirname, 'project', 'backend'),
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

    test('Should have uploaded assets to the apps intake', async ({ bundler }) => {
        // The apps plugin only uploads via Vite's closeBundle hook.
        if (bundler !== 'vite') {
            return;
        }

        const uploadRequest = readUploadRequest(bundler);
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

        // Extract the zip from the multipart body and verify asset structure.
        const bodyBuffer = Buffer.from(uploadRequest!.body, 'hex');
        const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
        const zipStart = bodyBuffer.indexOf(zipMagic);
        expect(zipStart).toBeGreaterThanOrEqual(0);

        const zip = await JSZip.loadAsync(bodyBuffer.subarray(zipStart));
        const filePaths = Object.keys(zip.files);
        expect(filePaths.length).toBeGreaterThan(0);

        // Every file should be under frontend/ or backend/.
        for (const filePath of filePaths) {
            expect(filePath).toMatch(/^(frontend|backend)\//);
        }

        // There should be at least one frontend asset.
        const frontendFiles = filePaths.filter((f) => f.startsWith('frontend/'));
        expect(frontendFiles.length).toBeGreaterThan(0);
    });

    // Backend function injection is only supported for vite.
    test('Should include backend functions in the uploaded archive', async ({ bundler }) => {
        // The apps plugin only uploads via Vite's closeBundle hook.
        if (bundler !== 'vite') {
            return;
        }

        const uploadRequest = readUploadRequest(bundler);
        expect(uploadRequest).not.toBeNull();

        const bodyBuffer = Buffer.from(uploadRequest!.body, 'hex');
        const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
        const zipStart = bodyBuffer.indexOf(zipMagic);
        const zip = await JSZip.loadAsync(bodyBuffer.subarray(zipStart));
        const filePaths = Object.keys(zip.files);
        const backendFiles = filePaths.filter((f) => f.startsWith('backend/'));

        // Verify the backend function is present in the archive.
        expect(backendFiles).toContain('backend/greet.js');

        // Verify the backend function bundle contains the wrapped entry.
        const greetContent = await zip.file('backend/greet.js')!.async('string');
        expect(greetContent).toContain('main');
        expect(greetContent).toContain('greet');
    });
});
