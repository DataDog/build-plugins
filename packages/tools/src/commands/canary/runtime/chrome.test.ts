// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, rm } from '@dd/core/helpers/fs';
// The core helpers can't set file modes.
import { chmod } from 'fs/promises';
import os from 'os';
import path from 'path';

import { CHROME_PATH_ENV, findChrome } from './chrome';

const TEST_ROOT = path.resolve(os.tmpdir(), `build-plugins-canary-chrome-${process.pid}`);
const FIRST_BIN = path.resolve(TEST_ROOT, 'first');
const SECOND_BIN = path.resolve(TEST_ROOT, 'second');

const createFile = async (filePath: string, mode: number): Promise<string> => {
    await outputFile(filePath, '#!/bin/sh\n');
    await chmod(filePath, mode);
    return filePath;
};

describe('Chrome lookup', () => {
    let firstChromium: string;
    let secondChrome: string;
    let notExecutable: string;

    beforeAll(async () => {
        await rm(TEST_ROOT);
        firstChromium = await createFile(path.resolve(FIRST_BIN, 'chromium'), 0o755);
        secondChrome = await createFile(path.resolve(SECOND_BIN, 'google-chrome'), 0o755);
        notExecutable = await createFile(path.resolve(FIRST_BIN, 'google-chrome'), 0o644);
    });

    afterAll(async () => {
        await rm(TEST_ROOT);
    });

    test('should prefer the explicit path over the environment', async () => {
        const chromePath = await findChrome({
            env: { [CHROME_PATH_ENV]: secondChrome, PATH: FIRST_BIN },
            explicitPath: firstChromium,
        });
        expect(chromePath).toBe(firstChromium);
    });

    test(`should use ${CHROME_PATH_ENV} before PATH`, async () => {
        const chromePath = await findChrome({
            env: { [CHROME_PATH_ENV]: secondChrome, PATH: FIRST_BIN },
            explicitPath: undefined,
        });
        expect(chromePath).toBe(secondChrome);
    });

    test('should prefer google-chrome on PATH and skip files that are not executable', async () => {
        const searchPath = [FIRST_BIN, SECOND_BIN].join(path.delimiter);
        const chromePath = await findChrome({ env: { PATH: searchPath }, explicitPath: undefined });
        // FIRST_BIN's google-chrome isn't executable, so SECOND_BIN's wins over chromium.
        expect(chromePath).toBe(secondChrome);
    });

    test('should fall back to chromium on PATH', async () => {
        const chromePath = await findChrome({ env: { PATH: FIRST_BIN }, explicitPath: undefined });
        expect(chromePath).toBe(firstChromium);
    });

    test('should explain how to set Chrome when it finds none', async () => {
        const emptyPath = path.resolve(TEST_ROOT, 'empty');
        const lookup = findChrome({ env: { PATH: emptyPath }, explicitPath: undefined });
        await expect(lookup).rejects.toThrow(CHROME_PATH_ENV);
    });

    test('should reject a configured path that is not executable', async () => {
        const lookup = findChrome({ env: {}, explicitPath: notExecutable });
        await expect(lookup).rejects.toThrow("isn't executable");
    });
});
