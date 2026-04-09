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

describe('Live Debugger', () => {
    beforeAll(async ({ publicDir, bundlers, suiteName }) => {
        const source = path.resolve(__dirname, 'project');
        const destination = path.resolve(publicDir, suiteName);
        await verifyProjectBuild(source, destination, bundlers, {
            ...defaultConfig,
            liveDebugger: {
                enable: true,
            },
        });
    });

    test('Should keep the app working without the debugger SDK', async ({
        page,
        bundler,
        browserName,
        suiteName,
        devServerUrl,
    }) => {
        const errors: string[] = [];
        const testBaseUrl = `${devServerUrl}/${suiteName}`;

        // Listen for runtime and network failures.
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (msg) => {
            if (msg.type() === 'error') {
                errors.push(`[console error] ${msg.text()}`);
            }
        });
        page.on('response', async (response) => {
            if (!response.ok()) {
                const url = response.request().url();
                const prefix = `[${bundler} ${browserName} ${response.status()}]`;
                errors.push(`${prefix} ${url}`);
            }
        });

        // It should load the correct bundler file too.
        const bundleRequest = page.waitForResponse(`${testBaseUrl}/dist/${bundler}.js`);
        await userFlow(testBaseUrl, page, bundler);
        expect((await bundleRequest).ok()).toBe(true);

        // The plugin should inject no-op globals so instrumented code can run safely
        // when the debugger SDK is absent.
        const hasProbeStub = await page.evaluate(() => typeof (globalThis as any).$dd_probes);
        expect(hasProbeStub).toBe('function');

        await expect(page.locator('#status')).toHaveText('Ready');
        await expect(page.locator('#count')).toHaveText('0');
        await expect(page.locator('#chunk-status')).toHaveText('Chunk not loaded');

        await page.getByRole('button', { name: 'Increment counter' }).click();
        await page.getByRole('button', { name: 'Increment counter' }).click();
        await expect(page.locator('#status')).toHaveText('Clicked 2 times');
        await expect(page.locator('#count')).toHaveText('2');

        await page.getByRole('button', { name: 'Load chunk' }).click();
        await expect(page.locator('#chunk-status')).toHaveText('Chunk loaded');

        // Verify all instrumentation code paths executed correctly
        // with the no-op probe stubs (no active probes).
        await expect(page.locator('#pattern-add')).toHaveText('5');
        await expect(page.locator('#pattern-addWithLocal')).toHaveText('5');
        await expect(page.locator('#pattern-double')).toHaveText('14');
        await expect(page.locator('#pattern-getObj')).toHaveText('{"key":"hello"}');
        await expect(page.locator('#pattern-sideEffect')).toHaveText('ok');
        await expect(page.locator('#pattern-abs')).toHaveText('5,3');
        await expect(page.locator('#pattern-earlyExit')).toHaveText('undefined,42');
        await expect(page.locator('#pattern-sign')).toHaveText('1,-1');
        await expect(page.locator('#pattern-thrower')).toHaveText('boom');

        expect(errors).toEqual([]);
    });

    test('Should work correctly with active probes', async ({
        page,
        bundler,
        browserName,
        suiteName,
        devServerUrl,
    }) => {
        const errors: string[] = [];
        const testBaseUrl = `${devServerUrl}/${suiteName}`;

        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (msg) => {
            if (msg.type() === 'error') {
                errors.push(`[console error] ${msg.text()}`);
            }
        });

        await userFlow(testBaseUrl, page, bundler);

        // Override globals to simulate the Datadog Browser Debugger SDK
        // being loaded with active probes. $dd_probes now returns a truthy
        // probe object, and $dd_entry/$dd_return/$dd_throw are recording stubs.
        // $dd_return must return the returnValue (its 2nd arg) because
        // the comma-expression return pattern uses its return value.
        const { values, entryCount, returnCount, throwCount } = await page.evaluate(() => {
            const g = globalThis as any;
            let entries = 0;
            let returns = 0;
            let throws = 0;

            g.$dd_probes = () => ({ active: true });
            g.$dd_entry = () => {
                entries++;
            };
            g.$dd_return = (_probe: unknown, returnValue: unknown) => {
                returns++;
                return returnValue;
            };
            g.$dd_throw = () => {
                throws++;
            };

            const p = g.ddTestPatterns;
            const v: Record<string, unknown> = {};

            v.add = p.add(2, 3);
            v.addWithLocal = p.addWithLocal(2, 3);
            v.double = p.double(7);
            v.getObj = p.getObj('hello');

            const arr: string[] = [];
            p.sideEffect(arr, 'ok');
            v.sideEffect = arr[0];

            v.absNeg = p.abs(-5);
            v.absPos = p.abs(3);
            v.earlyExitFalsy = p.earlyExit(0);
            v.earlyExitTruthy = p.earlyExit(42);
            v.signPos = p.sign(10);
            v.signNeg = p.sign(-10);

            try {
                p.thrower();
                v.thrower = 'no-error';
            } catch (e: unknown) {
                v.thrower = (e as Error).message;
            }

            return {
                values: v,
                entryCount: entries,
                returnCount: returns,
                throwCount: throws,
            };
        });

        // Return values must be preserved even with probes active.
        expect(values.add).toBe(5);
        expect(values.addWithLocal).toBe(5);
        expect(values.double).toBe(14);
        expect(values.getObj).toEqual({ key: 'hello' });
        expect(values.sideEffect).toBe('ok');
        expect(values.absNeg).toBe(5);
        expect(values.absPos).toBe(3);
        expect(values.earlyExitFalsy).toBeUndefined();
        expect(values.earlyExitTruthy).toBe(42);
        expect(values.signPos).toBe(1);
        expect(values.signNeg).toBe(-1);
        expect(values.thrower).toBe('boom');

        // Probe callbacks were actually invoked.
        expect(entryCount).toBeGreaterThan(0);
        expect(returnCount).toBeGreaterThan(0);
        expect(throwCount).toBe(1);

        expect(errors).toEqual([]);
    });
});
