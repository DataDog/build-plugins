// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { buildBackendFunctions } from '@dd/apps-plugin/vite/build-backend-functions';
import { existsSync, rm, rmSync } from '@dd/core/helpers/fs';
import { getMockLogger, mockLogger } from '@dd/tests/_jest/helpers/mocks';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { parseAst } from 'rollup/parseAst';
import type { build } from 'vite';

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
                ),
            ).rejects.toThrow('static check rejected a reachable helper module');

            const outDir = await outDirCreatedByLastCall();
            expect(existsSync(outDir)).toBe(false);
            expect(existsSync(decoyDir)).toBe(true);
        } finally {
            rmSync(decoyDir);
        }
    });
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
            configuredAllowedConnectionIds,
        );

        expect(result.functions[0].allowedConnectionIds).toEqual(configuredAllowedConnectionIds);
        if (result.outDir) {
            await rm(result.outDir);
        }
    });
});
