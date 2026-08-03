// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFileSync, rmSync } from '@dd/core/helpers/fs';
import os from 'os';
import path from 'path';

import { extractDebugId } from './debugId';

describe('extractDebugId', () => {
    const debugId = '93fd4850-7b77-4f2e-9aa2-ba013e1a5027';
    const tempDir = path.join(os.tmpdir(), 'dd-build-plugins-debug-id-test');

    afterEach(() => {
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

    test('Should return undefined when there is no debug ID in the content', async () => {
        const filePath = path.join(tempDir, 'no-debug-id.min.js');
        outputFileSync(
            filePath,
            `!function(){}({service:"app",version:"1.0.0"},"DD_SOURCE_CODE_CONTEXT");`,
        );

        await expect(extractDebugId(filePath)).resolves.toBeUndefined();
    });

    test('Should return undefined when the file cannot be read', async () => {
        const filePath = path.join(tempDir, 'missing.min.js');

        await expect(extractDebugId(filePath)).resolves.toBeUndefined();
    });
});
