// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogRspackPlugin } from '@datadog/rspack-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { datadogWebpackPlugin } from '@datadog/webpack-plugin';
import { rm } from '@dd/core/helpers/fs';
import { getUniqueId } from '@dd/core/helpers/strings';
import { prepareWorkingDir } from '@dd/tests/_jest/helpers/env';
import { easyProjectEntry, defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import {
    buildWithEsbuild,
    buildWithRollup,
    buildWithVite,
    buildWithWebpack,
    buildWithRspack,
} from '@dd/tools/bundlers';
import fsp from 'fs/promises';
import path from 'path';

const UUID_RX = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
// The snippet passes the debug_id as a quoted UUID argument to its IIFE.
// Match any quoted UUID-v4 string (quote style can change under minification).
const SNIPPET_DEBUG_ID_RX =
    /["']([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})["']/;

// Verify the runtime snippet was prepended and embeds a valid debug_id.
const expectDebugIdSnippet = (jsContent: string) => {
    expect(jsContent).toContain('DD_DEBUG_IDS');
    const match = jsContent.match(SNIPPET_DEBUG_ID_RX);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(UUID_RX);
};

describe('Debug ID Injection', () => {
    const seed = `${Math.abs(jest.getSeed())}.${getUniqueId()}`;
    let workingDir: string;

    beforeAll(async () => {
        workingDir = await prepareWorkingDir(seed);
    });

    afterAll(async () => {
        if (!process.env.NO_CLEANUP) {
            await rm(workingDir);
        }
    });

    test('esbuild: prepends the DD_DEBUG_IDS snippet with a valid debug_id', async () => {
        const outDir = path.resolve(workingDir, 'dist-debug-id-esbuild');
        const { errors } = await buildWithEsbuild({
            absWorkingDir: workingDir,
            bundle: true,
            entryPoints: { main: path.resolve(workingDir, easyProjectEntry) },
            outdir: outDir,
            sourcemap: true,
            plugins: [
                datadogEsbuildPlugin({
                    ...defaultPluginOptions,
                    errorTracking: { debugId: true },
                }),
            ],
        });

        expect(errors).toEqual([]);

        const jsContent = await fsp.readFile(path.resolve(outDir, 'main.js'), 'utf-8');
        expectDebugIdSnippet(jsContent);
    });

    test('rollup: prepends the DD_DEBUG_IDS snippet with a valid debug_id', async () => {
        const outDir = path.resolve(workingDir, 'dist-debug-id-rollup');
        const { errors } = await buildWithRollup({
            input: { main: path.resolve(workingDir, easyProjectEntry) },
            output: { dir: outDir, sourcemap: true },
            plugins: [
                datadogRollupPlugin({
                    ...defaultPluginOptions,
                    errorTracking: { debugId: true },
                }),
            ],
        });

        expect(errors).toEqual([]);

        const jsContent = await fsp.readFile(path.resolve(outDir, 'main.js'), 'utf-8');
        expectDebugIdSnippet(jsContent);
    });

    test('vite: prepends the DD_DEBUG_IDS snippet with a valid debug_id', async () => {
        const outDir = path.resolve(workingDir, 'dist-debug-id-vite');
        const { errors } = await buildWithVite({
            root: workingDir,
            build: {
                outDir,
                sourcemap: true,
                rollupOptions: {
                    input: { main: path.resolve(workingDir, easyProjectEntry) },
                    output: { entryFileNames: 'assets/[name].js' },
                },
            },
            plugins: [
                datadogVitePlugin({
                    ...defaultPluginOptions,
                    errorTracking: { debugId: true },
                }),
            ],
        });

        expect(errors).toEqual([]);

        const jsContent = await fsp.readFile(path.resolve(outDir, 'assets/main.js'), 'utf-8');
        expectDebugIdSnippet(jsContent);
    });

    test('webpack: prepends the DD_DEBUG_IDS snippet with a valid debug_id', async () => {
        const outDir = path.resolve(workingDir, 'dist-debug-id-webpack');
        const { errors } = await buildWithWebpack({
            context: workingDir,
            mode: 'development',
            devtool: 'source-map',
            entry: { main: path.resolve(workingDir, easyProjectEntry) },
            output: { path: outDir },
            plugins: [
                datadogWebpackPlugin({
                    ...defaultPluginOptions,
                    errorTracking: { debugId: true },
                }),
            ],
        });

        expect(errors).toEqual([]);

        const jsContent = await fsp.readFile(path.resolve(outDir, 'main.js'), 'utf-8');
        expectDebugIdSnippet(jsContent);
    });

    test('rspack: prepends the DD_DEBUG_IDS snippet with a valid debug_id', async () => {
        const outDir = path.resolve(workingDir, 'dist-debug-id-rspack');
        const { errors } = await buildWithRspack({
            context: workingDir,
            mode: 'development',
            devtool: 'source-map',
            entry: { main: path.resolve(workingDir, easyProjectEntry) },
            output: { path: outDir },
            plugins: [
                datadogRspackPlugin({
                    ...defaultPluginOptions,
                    errorTracking: { debugId: true },
                }),
            ],
        });

        expect(errors).toEqual([]);

        const jsContent = await fsp.readFile(path.resolve(outDir, 'main.js'), 'utf-8');
        expectDebugIdSnippet(jsContent);
    });
});
