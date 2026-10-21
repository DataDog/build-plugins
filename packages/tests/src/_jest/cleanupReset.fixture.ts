// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';

import {
    CLEANUP_MARKER,
    WORKING_DIR_NAME,
    getMarkerCleanup,
    getMarkerDir,
} from './cleanupFixtureShared';

const { mkdirSync } =
    jest.requireActual<typeof import('@dd/core/helpers/fs')>('@dd/core/helpers/fs');

// Not named `*.test.*`: setupAfterEnv.test.ts spawns it, then checks that setupAfterEnv's afterAll
// still ran what it registered, although the module registry was reset before and after.
beforeEach(() => {
    jest.resetModules();
});

afterEach(() => {
    jest.resetModules();
});

test('Should register a working directory and a cleanup from a copy loaded after a reset', () => {
    const { addCleanup, addWorkingDir } =
        jest.requireActual<typeof import('./helpers/cleanups')>('./helpers/cleanups');
    const markerDir = getMarkerDir();
    const workingDir = path.join(markerDir, WORKING_DIR_NAME);
    mkdirSync(workingDir);
    const cleanup = getMarkerCleanup(CLEANUP_MARKER);

    addWorkingDir(workingDir);
    addCleanup(cleanup);

    expect(cleanup.errors).toEqual([]);
});
