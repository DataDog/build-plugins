// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { outputFileSync, readFile, rmSync } from '@dd/core/helpers/fs';
import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { rollup, type Plugin } from 'rollup';

import { DEBUG_ID_SEARCH_CHUNK_BYTES, extractDebugId } from './debugId';

describe('extractDebugId', () => {
    const debugId = '93fd4850-7b77-4f2e-9aa2-ba013e1a5027';
    const tempDir = path.join(os.tmpdir(), 'dd-build-plugins-debug-id-test');

    afterEach(() => {
        jest.restoreAllMocks();
        rmSync(tempDir);
    });

    test('Should extract the debug ID when the key is quoted (unminified JSON.stringify output)', async () => {
        const filePath = path.join(tempDir, 'quoted.min.js');
        outputFileSync(
            filePath,
            `!function(){}({"service":"app","version":"1.0.0","ddDebugId":"${debugId}"},"DD_SOURCE_CODE_CONTEXT");`,
        );

        await expect(extractDebugId(filePath)).resolves.toBe(debugId);
    });

    test('Should extract the debug ID when the key is unquoted (minifiers strip quotes from valid identifier keys)', async () => {
        const filePath = path.join(tempDir, 'unquoted.min.js');
        outputFileSync(
            filePath,
            `!function(){}({service:"app",version:"1.0.0",ddDebugId:"${debugId}"},"DD_SOURCE_CODE_CONTEXT");`,
        );

        await expect(extractDebugId(filePath)).resolves.toBe(debugId);
    });

    test('Should stop reading after finding the debug ID in the first chunk', async () => {
        const filePath = path.join(tempDir, 'first-chunk.min.js');
        const literal = `ddDebugId:"${debugId}"`;
        outputFileSync(filePath, `${literal}${'x'.repeat(DEBUG_ID_SEARCH_CHUNK_BYTES * 2)}`);

        const fileHandle = await fsp.open(filePath, 'r');
        const read = jest.spyOn(fileHandle, 'read');
        const close = jest.spyOn(fileHandle, 'close');
        jest.spyOn(fsp, 'open').mockResolvedValue(fileHandle);

        await expect(extractDebugId(filePath)).resolves.toBe(debugId);
        expect(read).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
    });

    test('Should return undefined when there is no debug ID in the content', async () => {
        const filePath = path.join(tempDir, 'no-debug-id.min.js');
        outputFileSync(
            filePath,
            `!function(){}({service:"app",version:"1.0.0"},"DD_SOURCE_CODE_CONTEXT");`,
        );

        await expect(extractDebugId(filePath)).resolves.toBeUndefined();
    });

    test('Should progressively find a debug ID after the first chunk', async () => {
        const filePath = path.join(tempDir, 'later-debug-id.min.js');
        outputFileSync(
            filePath,
            `${'x'.repeat(DEBUG_ID_SEARCH_CHUNK_BYTES + 100)}ddDebugId:"${debugId}"`,
        );

        await expect(extractDebugId(filePath)).resolves.toBe(debugId);
    });

    test('Should find a debug ID split across two chunks', async () => {
        const filePath = path.join(tempDir, 'split-debug-id.min.js');
        const literal = `ddDebugId:"${debugId}"`;
        const literalPrefixBytes = 20;
        outputFileSync(
            filePath,
            `${'x'.repeat(DEBUG_ID_SEARCH_CHUNK_BYTES - literalPrefixBytes)}${literal}`,
        );

        await expect(extractDebugId(filePath)).resolves.toBe(debugId);
    });

    test('Should scan to EOF and return undefined when a large file has no debug ID', async () => {
        const filePath = path.join(tempDir, 'large-no-debug-id.min.js');
        outputFileSync(filePath, 'x'.repeat(DEBUG_ID_SEARCH_CHUNK_BYTES * 3 + 100));

        await expect(extractDebugId(filePath)).resolves.toBeUndefined();
    });

    test('Should return undefined when the file cannot be read', async () => {
        const filePath = path.join(tempDir, 'missing.min.js');

        await expect(extractDebugId(filePath)).resolves.toBeUndefined();
    });

    test('Should keep a Rollup debug ID in the search prefix after later chunk transforms', async () => {
        const inputPath = path.join(tempDir, 'input.js');
        const outputDir = path.join(tempDir, 'dist');
        const outputPath = path.join(outputDir, 'main.js');
        outputFileSync(inputPath, 'console.log("hello");');

        const datadogPlugin = datadogRollupPlugin({
            ...defaultPluginOptions,
            enableGit: false,
            logLevel: 'none',
            rum: {
                sourceCodeContext: {
                    debugId: true,
                    service: 'test-service',
                    version: '1.0.0',
                },
            },
        });
        const lateChunkTransform: Plugin = {
            name: 'late-chunk-transform',
            renderChunk(code) {
                const padding = `/*${'x'.repeat(DEBUG_ID_SEARCH_CHUNK_BYTES)}*/`;
                return `${padding}\n${code}`;
            },
        };
        const bundle = await rollup({
            input: inputPath,
            plugins: [datadogPlugin, lateChunkTransform],
        });

        await bundle.write({
            dir: outputDir,
            entryFileNames: 'main.js',
            format: 'es',
        });
        await bundle.close();

        const content = await readFile(outputPath);
        expect(content.indexOf('ddDebugId')).toBeLessThan(DEBUG_ID_SEARCH_CHUNK_BYTES);
        await expect(extractDebugId(outputPath)).resolves.toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
    });
});
