// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createBackendStaticChecks } from '@dd/apps-plugin/backend/ast-parsing/run-backend-static-checks';
import { buildBackendFunctions } from '@dd/apps-plugin/vite/build-backend-functions';
import { existsSync, outputFileSync, readFileSync, rm, rmSync } from '@dd/core/helpers/fs';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import { getMockLogger, mockLogger } from '@dd/tests/_jest/helpers/mocks';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { parseAst } from 'rollup/parseAst';
import { pathToFileURL } from 'url';
import { build } from 'vite';

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
function emitModuleParsed(
    config: {
        plugins?: Array<{
            moduleParsed?: (this: { parse: typeof parseAst }, moduleInfo: unknown) => void;
        }>;
    },
    id: string,
    code: string,
) {
    for (const plugin of config.plugins ?? []) {
        plugin.moduleParsed?.call(
            { parse: parseAst },
            {
                id,
                code,
                importedIds: [],
            },
        );
    }
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
                createBackendStaticChecks(mockLogger),
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
                createBackendStaticChecks(logger),
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
                    createBackendStaticChecks(mockLogger),
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
                createBackendStaticChecks(mockLogger),
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

    test('merges configured allowedConnectionIds into each built backend function', async () => {
        const testFunc: BackendFunction = {
            ...func,
            absolutePath: '/project/src/example.backend.ts',
        };
        const mockViteBuild = jest.fn().mockImplementation(async (config) => {
            emitModuleParsed(
                config,
                testFunc.absolutePath,
                'export function example() { return null; }',
            );
            return {
                output: [
                    {
                        type: 'chunk',
                        fileName: 'example.js',
                        code: 'console.log("hello");',
                    },
                ],
            };
        });

        const configuredAllowedConnectionIds = [
            '11111111-2222-3333-4444-555555555555',
            '22222222-3333-4444-5555-666666666666',
        ];

        const result = await buildBackendFunctions(
            mockViteBuild as unknown as typeof build,
            [testFunc],
            '/project',
            mockLogger,
            createBackendStaticChecks(mockLogger),
            configuredAllowedConnectionIds,
        );

        expect(result.functions[0].allowedConnectionIds).toEqual(configuredAllowedConnectionIds);
        if (result.outDir) {
            await rm(result.outDir);
        }
    });
});
