// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { buildBackendFunctions } from '@dd/apps-plugin/vite/build-backend-functions';
import { existsSync, outputFileSync, readFileSync, rm, rmSync } from '@dd/core/helpers/fs';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import { getMockLogger, mockLogger } from '@dd/tests/_jest/helpers/mocks';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { build } from 'vite';

import type { BackendRuntime } from '../backend-runtime';
import type { BackendFunction } from '../backend/types';

jest.mock('@dd/core/helpers/fs', () => ({
    ...jest.requireActual('@dd/core/helpers/fs'),
    rm: jest.fn(jest.requireActual('@dd/core/helpers/fs').rm),
}));

jest.mock('fs/promises', () => ({
    ...jest.requireActual('fs/promises'),
    mkdtemp: jest.fn(jest.requireActual('fs/promises').mkdtemp),
}));

const rmMock = jest.mocked(rm);
const mkdtempMock = jest.mocked(mkdtemp);

const func: BackendFunction = {
    relativePath: 'src/example',
    name: 'example',
    absolutePath: '/src/example.backend.ts',
    allowedConnectionIds: [],
};

// Reads back the exact directory this call created, instead of diffing the OS-wide `dd-apps-backend-*` namespace — Jest's parallel worker processes share one OS tmpdir(), so a concurrent sibling test would race a namespace-wide diff.
async function outDirCreatedByLastCall(): Promise<string> {
    const lastCall = mkdtempMock.mock.results.at(-1);
    if (!lastCall) {
        throw new Error('mkdtemp was never called');
    }
    return lastCall.value;
}

describe('buildBackendFunctions', () => {
    test('Should clean up the temp output directory when a per-function vite.build() call throws (e.g. a static check rejects a reachable helper module)', async () => {
        const failingViteBuild = jest
            .fn()
            .mockRejectedValue(new Error('static check rejected a reachable helper module'));

        await expect(
            buildBackendFunctions(
                failingViteBuild as unknown as typeof build,
                [func],
                '/project',
                mockLogger,
                'v1',
            ),
        ).rejects.toThrow('static check rejected a reachable helper module');

        // outDir is only returned for the caller to clean up on success, so a rejected build must clean up its own temp directory.
        const outDir = await outDirCreatedByLastCall();
        expect(existsSync(outDir)).toBe(false);
    });

    test('Should still surface the original build failure, not the cleanup failure, when temp-directory cleanup itself throws', async () => {
        rmMock.mockRejectedValueOnce(new Error('EACCES: permission denied'));

        const warnMock = jest.fn();
        const logger = getMockLogger({ warn: warnMock });
        const failingViteBuild = jest
            .fn()
            .mockRejectedValue(new Error('static check rejected a reachable helper module'));

        await expect(
            buildBackendFunctions(
                failingViteBuild as unknown as typeof build,
                [func],
                '/project',
                logger,
                'v1',
            ),
        ).rejects.toThrow('static check rejected a reachable helper module');

        expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('EACCES'));

        // The mocked rm() rejected without deleting anything, so this test's own leaked directory needs manual cleanup.
        const outDir = await outDirCreatedByLastCall();
        rmSync(outDir);
    });

    test('Should ignore other dd-apps-backend-* temp directories that exist concurrently, e.g. from a sibling test file building its own backend functions in parallel', async () => {
        const decoyDir = await mkdtemp(path.join(tmpdir(), 'dd-apps-backend-'));

        try {
            const failingViteBuild = jest
                .fn()
                .mockRejectedValue(new Error('static check rejected a reachable helper module'));

            await expect(
                buildBackendFunctions(
                    failingViteBuild as unknown as typeof build,
                    [func],
                    '/project',
                    mockLogger,
                    'v1',
                ),
            ).rejects.toThrow('static check rejected a reachable helper module');

            const outDir = await outDirCreatedByLastCall();
            expect(existsSync(outDir)).toBe(false);
            expect(existsSync(decoyDir)).toBe(true);
        } finally {
            rmSync(decoyDir);
        }
    });

    test('Should minify production bundles while keeping function and class names in stack traces', async () => {
        const seed = `build-backend-minify-${Date.now()}`;
        const workingDir = getTempWorkingDir(seed);
        let outDir: string | undefined;
        try {
            const absolutePath = `${workingDir}/src/names.backend.ts`;
            outputFileSync(
                absolutePath,
                `
            class BackendValidationError extends Error {}
            const readableHelper = (value: string) => {
                if (!value) throw new BackendValidationError('missing value');
                return value;
            };
            export async function readableBackendFunction(value: string) {
                return readableHelper(value);
            }
        `,
            );
            const namesFunc: BackendFunction = {
                relativePath: 'src/names',
                name: 'readableBackendFunction',
                absolutePath,
                allowedConnectionIds: [],
            };

            const result = await buildBackendFunctions(
                build,
                [namesFunc],
                workingDir,
                mockLogger,
                'v1',
            );
            outDir = result.outDir;
            const [bundlePath] = [...result.outputs.values()];
            const bundleCode = readFileSync(bundlePath);
            const bundleUrl = pathToFileURL(bundlePath).href;
            // Dynamic: the bundle only exists once the build above has written it.
            const bundle: { main: (globals: unknown) => Promise<unknown> } = await import(
                bundleUrl
            );
            const failure: unknown = await bundle
                .main({ backendFunctionArgs: [''] })
                .catch((error: unknown) => error);

            // Minified: the unminified output spans many lines.
            expect(bundleCode.trim().split('\n').length).toBeLessThan(5);
            if (!(failure instanceof Error)) {
                throw new Error('Expected the backend function to throw an Error.');
            }
            const { constructor, stack } = failure;
            expect(constructor.name).toBe('BackendValidationError');
            expect(stack).toContain('readableHelper');
            expect(stack).toContain('readableBackendFunction');
        } finally {
            rmSync(workingDir);
            if (outDir) {
                rmSync(outDir);
            }
        }
    }, 30000);

    const runtimeCases: Array<{ runtime: BackendRuntime; expected: unknown }> = [
        { runtime: 'v1', expected: expect.stringContaining('Importing Node built-in module "os"') },
        { runtime: 'v2', expected: 'built' },
    ];
    test.each(runtimeCases)(
        'Should apply the static checks for the $runtime runtime to a reachable helper module',
        async ({ runtime, expected }) => {
            const seed = `build-backend-runtime-${runtime}-${Date.now()}`;
            const workingDir = getTempWorkingDir(seed);
            let outDir: string | undefined;
            try {
                outputFileSync(
                    `${workingDir}/src/helper.ts`,
                    "import os from 'os';\nexport const host = () => os.hostname();\nexport const ping = () => fetch('https://example.com');\n",
                );
                const absolutePath = `${workingDir}/src/net.backend.ts`;
                outputFileSync(
                    absolutePath,
                    "import { host, ping } from './helper';\nexport async function check() { await ping(); return host(); }\n",
                );
                const netFunc: BackendFunction = {
                    relativePath: 'src/net',
                    name: 'check',
                    absolutePath,
                    allowedConnectionIds: [],
                };

                const outcome = await buildBackendFunctions(
                    build,
                    [netFunc],
                    workingDir,
                    mockLogger,
                    runtime,
                ).then(
                    (result) => {
                        outDir = result.outDir;
                        return 'built';
                    },
                    (error: unknown) => (error instanceof Error ? error.message : String(error)),
                );

                expect(outcome).toEqual(expected);
            } finally {
                rmSync(workingDir);
                if (outDir) {
                    rmSync(outDir);
                }
            }
        },
        30000,
    );
});
