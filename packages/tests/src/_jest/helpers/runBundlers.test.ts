// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as fsHelpers from '@dd/core/helpers/fs';

import { BUNDLERS, cleanupEverything, runBundlers } from './runBundlers';

const { existsSync, rm } = fsHelpers;

const setNoCleanup = (noCleanup: boolean) => {
    if (noCleanup) {
        process.env.NO_CLEANUP = '1';
    } else {
        delete process.env.NO_CLEANUP;
    }
};

// Stands in for a real build, so the module registers this cleanup without bundling anything.
const mockBundlerCleanup = (implementation: () => Promise<void>) => {
    const [bundler] = BUNDLERS;
    const errors: string[] = [];
    const bundlerCleanup = Object.assign(jest.fn(implementation), { errors, workingDir: '' });
    jest.spyOn(bundler, 'run').mockResolvedValue(bundlerCleanup);
    return { bundlerName: bundler.name, bundlerCleanup };
};

const getCleanupError = async () => {
    try {
        await cleanupEverything();
    } catch (error) {
        return error;
    }
    return undefined;
};

describe('runBundlers working directory', () => {
    const noBundlers: string[] = [];
    const cases = [
        {
            description: 'remove the working directory and run the bundler cleanups',
            noCleanupAtRun: false,
            noCleanupAtCleanup: false,
            expectedToExist: false,
            expectedCleanupCalls: 1,
        },
        {
            description: 'keep everything with --cleanup=0',
            noCleanupAtRun: true,
            noCleanupAtCleanup: true,
            expectedToExist: true,
            expectedCleanupCalls: 0,
        },
        {
            description: 'clean up everything when NO_CLEANUP is only set after the run',
            noCleanupAtRun: false,
            noCleanupAtCleanup: true,
            expectedToExist: false,
            expectedCleanupCalls: 1,
        },
        {
            description: 'keep everything when NO_CLEANUP is only unset after the run',
            noCleanupAtRun: true,
            noCleanupAtCleanup: false,
            expectedToExist: true,
            expectedCleanupCalls: 0,
        },
    ];

    let initialNoCleanup: typeof process.env.NO_CLEANUP;
    const workingDirs: string[] = [];

    beforeEach(() => {
        initialNoCleanup = process.env.NO_CLEANUP;
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        if (initialNoCleanup === undefined) {
            delete process.env.NO_CLEANUP;
        } else {
            process.env.NO_CLEANUP = initialNoCleanup;
        }
        const removals = workingDirs.splice(0).map((workingDir) => rm(workingDir));
        await Promise.all(removals);
    });

    test.each(cases)(
        'Should $description',
        async ({ noCleanupAtRun, noCleanupAtCleanup, expectedToExist, expectedCleanupCalls }) => {
            const { bundlerName, bundlerCleanup } = mockBundlerCleanup(async () => {});
            setNoCleanup(noCleanupAtRun);

            const result = await runBundlers({}, {}, [bundlerName]);
            workingDirs.push(result.workingDir);

            const existsAfterRun = existsSync(result.workingDir);
            setNoCleanup(noCleanupAtCleanup);
            await cleanupEverything();
            const existsAfterCleanup = existsSync(result.workingDir);

            expect(existsAfterRun).toBe(true);
            expect(existsAfterCleanup).toBe(expectedToExist);
            expect(bundlerCleanup).toHaveBeenCalledTimes(expectedCleanupCalls);
        },
    );

    test('Should remove the other working directories before failing on a removal error', async () => {
        setNoCleanup(false);

        const failing = await runBundlers({}, {}, noBundlers);
        const other = await runBundlers({}, {}, noBundlers);
        workingDirs.push(failing.workingDir, other.workingDir);

        jest.spyOn(fsHelpers, 'rm').mockImplementation(async (dir) => {
            if (dir === failing.workingDir) {
                throw new Error(`EACCES: permission denied, rm '${dir}'`);
            }
            return rm(dir);
        });

        const cleanupError = await getCleanupError();

        const otherExists = existsSync(other.workingDir);
        const namesFailedPath = expect.stringContaining(failing.workingDir);
        expect(otherExists).toBe(false);
        expect(cleanupError).toBeInstanceOf(AggregateError);
        expect(cleanupError).toHaveProperty('message', namesFailedPath);
    });

    test('Should remove the working directory even when a bundler cleanup fails', async () => {
        const bundlerError = new Error('Bundler cleanup failed.');
        const { bundlerName } = mockBundlerCleanup(async () => {
            throw bundlerError;
        });
        setNoCleanup(false);

        const result = await runBundlers({}, {}, [bundlerName]);
        workingDirs.push(result.workingDir);

        const cleanupError = await getCleanupError();

        const workingDirExists = existsSync(result.workingDir);
        const namesBundlerError = expect.stringContaining(bundlerError.message);
        expect(workingDirExists).toBe(false);
        expect(cleanupError).toBeInstanceOf(AggregateError);
        expect(cleanupError).toHaveProperty('message', namesBundlerError);
    });
});
