// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    ORPHAN_CLEANUP_MARKER,
    ORPHAN_REGISTERED_MARKER,
    getMarkerCleanup,
    writeMarker,
} from './cleanupFixtureShared';
import { addCleanup } from './helpers/cleanups';

// Not named `*.test.*`: setupAfterEnv.test.ts runs it before cleanupOrphanB.fixture.ts and checks
// that a cleanup registered after this file's own cleanup ran is not run by the next file.
// Runs after setupAfterEnv's afterAll, like a build that outlives its test file.
afterAll(() => {
    const orphanCleanup = getMarkerCleanup(ORPHAN_CLEANUP_MARKER);
    addCleanup(orphanCleanup);
    writeMarker(ORPHAN_REGISTERED_MARKER);
});

test('Should give the file a test, so its afterAll runs', () => {
    const orphanCleanup = getMarkerCleanup(ORPHAN_CLEANUP_MARKER);
    expect(orphanCleanup.errors).toEqual([]);
});
