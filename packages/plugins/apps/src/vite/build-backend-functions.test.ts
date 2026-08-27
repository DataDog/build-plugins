// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { buildBackendFunctions } from '@dd/apps-plugin/vite/build-backend-functions';
import { rm } from '@dd/core/helpers/fs';
import { getMockLogger, mockLogger } from '@dd/tests/_jest/helpers/mocks';
import { mkdtemp } from 'fs/promises';
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { build } from 'vite';

import type { BackendFunction } from '../backend/types';

jest.mock('@dd/core/helpers/fs', () => ({
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

// Reads back the exact directory this call created, instead of diffing the OS-wide `dd-apps-backend-*` namespace — Jest runs test files in parallel worker processes that all share the same OS tmpdir(), so a sibling test file building its own backend functions concurrently would otherwise race a namespace-wide diff.
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
            ),
        ).rejects.toThrow('static check rejected a reachable helper module');

        // outDir is only returned for the caller to clean up on success, so a rejected build must clean up its own temp directory.
        const outDir = await outDirCreatedByLastCall();
        expect(fs.existsSync(outDir)).toBe(false);
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
        fs.rmSync(outDir, { recursive: true, force: true });
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
            expect(fs.existsSync(outDir)).toBe(false);
            expect(fs.existsSync(decoyDir)).toBe(true);
        } finally {
            fs.rmSync(decoyDir, { recursive: true, force: true });
        }
    });
});
