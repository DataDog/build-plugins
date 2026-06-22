// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global window */
import { readFile } from '@dd/core/helpers/fs';
import { InjectPosition } from '@dd/core/types';
import type { GetPluginsArg } from '@dd/core/types';
import { verifyProjectBuild } from '@dd/tests/_playwright/helpers/buildProject';
import { test } from '@dd/tests/_playwright/testParams';
import { defaultConfig } from '@dd/tools/plugins';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import path from 'path';

declare global {
    interface Window {
        throwForSourcemap(): void;
    }
}

const { expect, beforeAll, describe } = test;

const pluginConfig = {
    ...defaultConfig,
    customPlugins: ({ context }: GetPluginsArg) => {
        context.inject({
            type: 'code',
            value: 'console.log("dd_banner");',
            position: InjectPosition.BEFORE,
        });
        return [{ name: 'injection-test-plugin' }];
    },
};

describe('Injection', () => {
    beforeAll(async ({ publicDir, bundlers, suiteName }) => {
        const source = path.resolve(__dirname, 'project');
        const destination = path.resolve(publicDir, suiteName);
        await verifyProjectBuild(source, destination, bundlers, pluginConfig);
    });

    test('Should preserve sourcemap positions after banner injection', async ({
        page,
        bundler,
        browserName,
        suiteName,
        devServerUrl,
        publicDir,
    }) => {
        test.skip(browserName !== 'chromium', 'Stack trace format is Chromium-specific');

        await page.goto(`${devServerUrl}/${suiteName}/index.html?context_bundler=${bundler}`);
        await page.waitForSelector('body');

        // Capture the raw (non-resolved) stack trace from a throw at a known fixture line.
        const stack = await page.evaluate(() => {
            try {
                window.throwForSourcemap();
            } catch (e) {
                return e instanceof Error ? e.stack ?? '' : '';
            }
            return '';
        });

        // Parse the Chromium stack frame: "at throwForSourcemap (http://host/dist/bundler.js:LINE:COL)"
        const frameMatch = stack.match(/at throwForSourcemap \(.*?(\d+):(\d+)\)/);
        expect(frameMatch).not.toBeNull();
        const outputLine = parseInt(frameMatch![1], 10);
        const outputCol = parseInt(frameMatch![2], 10) - 1;

        // Read the sourcemap produced by the bundler.
        const distDir = path.resolve(publicDir, suiteName, 'dist');
        const mapContent = await readFile(path.resolve(distDir, `${bundler}.js.map`));

        // Resolve the output position back to the original source.
        const tracer = new TraceMap(JSON.parse(mapContent));
        const mapping = originalPositionFor(tracer, { line: outputLine, column: outputCol });

        // The resolved source must be the original index.js, not the injected banner.
        expect(mapping.source).toMatch(/index\.js$/);
        expect(mapping.line).toBe(9);

        // The resolved original line must contain the throw statement.
        const originalSrc = await readFile(path.resolve(publicDir, suiteName, 'index.js'));
        const originalLine = originalSrc.split('\n')[(mapping.line ?? 0) - 1];
        expect(originalLine).toContain("throw new Error('sourcemap_test')");
    });
});
