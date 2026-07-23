// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as fsHelpers from '@dd/core/helpers/fs';
import { runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import fsp from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

const BACKEND_OUT_DIR_PREFIX = 'dd-apps-backend-';
const BUNDLE_FILENAME_RE = /^[0-9a-f]{64}\.(.+)\.js$/;

type BackendMainModule = {
    main: (context: unknown) => Promise<unknown>;
};

function isBackendMainModule(mod: unknown): mod is BackendMainModule {
    if (typeof mod !== 'object' || mod === null) {
        return false;
    }
    if (!('main' in mod)) {
        return false;
    }
    return typeof mod.main === 'function';
}

describe('apps backend runtime — real @datadog/apps-backend integration', () => {
    let backendOutDir: string | undefined;
    let bundlesByFunctionName: Map<string, string>;

    beforeAll(async () => {
        const realRm = fsHelpers.rm;
        const rmSpy = jest.spyOn(fsHelpers, 'rm').mockImplementation(async (dir: string) => {
            if (dir.includes(BACKEND_OUT_DIR_PREFIX)) {
                backendOutDir = dir;
                return;
            }
            await realRm(dir);
        });

        const { errors } = await runBundlers(
            { apps: { identifier: 'app-id', name: 'test-app', dryRun: true } },
            { entry: { main: './apps_backend_project/main.ts' } },
            ['vite'],
        );
        rmSpy.mockRestore();

        if (errors.length > 0) {
            throw new Error(`Expected no build errors, got: ${errors.join(', ')}`);
        }
        if (!backendOutDir) {
            throw new Error('Expected the apps plugin to build backend function bundles.');
        }

        const files = await fsp.readdir(backendOutDir);
        bundlesByFunctionName = new Map();
        for (const file of files) {
            const match = BUNDLE_FILENAME_RE.exec(file);
            if (match) {
                bundlesByFunctionName.set(match[1], path.join(backendOutDir, file));
            }
        }
    }, 30000);

    afterAll(async () => {
        if (backendOutDir) {
            await fsp.rm(backendOutDir, { recursive: true, force: true });
        }
    });

    const importBackendMain = async (functionName: string) => {
        const bundlePath = bundlesByFunctionName.get(functionName);
        if (!bundlePath) {
            throw new Error(`No emitted bundle found for backend function "${functionName}".`);
        }
        const mod: unknown = await import(pathToFileURL(bundlePath).href);
        if (!isBackendMainModule(mod)) {
            throw new Error(`Expected ${bundlePath} to export a "main" function.`);
        }
        return mod.main;
    };

    const validSource = () => ({
        initiator: { id: 'initiator-id', orgId: 'org-1' },
        runAsUser: { id: 'run-as-id', orgId: 'org-1' },
    });

    test('resolves execution and initiating users from the real SDK', async () => {
        const main = await importBackendMain('getRuntimeUsers');
        const { initiator, runAsUser } = validSource();

        const result = await main({
            Source: { initiator, runAsUser },
            backendFunctionArgs: ['integration-test'],
        });

        expect(result).toEqual({
            label: 'integration-test',
            executionUser: runAsUser,
            initiatingUser: initiator,
        });
    });

    test('forwards arguments to the backend function', async () => {
        const main = await importBackendMain('plainEcho');

        const result = await main({
            Source: validSource(),
            backendFunctionArgs: ['hello'],
        });

        expect(result).toEqual({ value: 'hello' });
    });

    test('a backend that does not use the runtime SDK still works', async () => {
        const main = await importBackendMain('noSdkFunction');

        const result = await main({
            Source: validSource(),
            backendFunctionArgs: [],
        });

        expect(result).toEqual({ ok: true });
    });

    test('rejects an invalid context', async () => {
        const main = await importBackendMain('getRuntimeUsers');

        await expect(
            main({
                Source: {
                    initiator: { orgId: 'org-1' },
                    runAsUser: { id: 'run-as-id', orgId: 'org-1' },
                },
                backendFunctionArgs: ['integration-test'],
            }),
        ).rejects.toThrow(/is missing the required "id" property/);
    });
});
