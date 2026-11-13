// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getEsbuildMock } from '@dd/tests/_jest/helpers/mocks';

import { createBuildModeTracker } from './build-mode';

type EsbuildBuild = ReturnType<typeof getEsbuildMock>;
type StartCallback = Parameters<EsbuildBuild['onStart']>[0];

// Set up the esbuild hook, start the given number of builds, and say after each start whether
// the build counts as one-off.
const runEsbuildBuilds = async (buildCount: number): Promise<boolean[]> => {
    const tracker = createBuildModeTracker();
    const startCallbacks: StartCallback[] = [];
    const build = getEsbuildMock({
        onStart: (callback) => {
            startCallbacks.push(callback);
        },
    });
    const setup = tracker.hooks.esbuild?.setup;
    if (!setup) {
        throw new Error('Expected an esbuild setup hook.');
    }
    await setup(build);

    const results: boolean[] = [];
    for (let index = 0; index < buildCount; index += 1) {
        for (const callback of startCallbacks) {
            callback();
        }
        const isOneOffBuild = tracker.isOneOffBuild();
        results.push(isOneOffBuild);
    }
    return results;
};

describe('createBuildModeTracker', () => {
    const cases = [
        {
            description: 'count a single esbuild build as one-off',
            buildCount: 1,
            expected: [true],
        },
        {
            description: 'count only the first esbuild build as one-off',
            buildCount: 3,
            expected: [true, false, false],
        },
    ];

    test.each(cases)('should $description', async ({ buildCount, expected }) => {
        const results = await runEsbuildBuilds(buildCount);
        expect(results).toEqual(expected);
    });
});
