// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import console from 'console';
import https from 'https';
import http from 'http';
import { protectProperties } from 'jest-util';

import { scrubEnv } from './helpers/allowedEnv.ts';
import { protectInterceptors } from './helpers/protectInterceptors.ts';
import { resetSharedHttpPatches } from './helpers/sharedHttpPatches.ts';
import { toBeWithinRange } from './toBeWithinRange.ts';
import { toRepeatStringTimes } from './toRepeatStringTimes.ts';

// Extend Jest's expect with custom matchers.
expect.extend({
    // @ts-expect-error - TypeScript doesn't recognize the custom matchers.
    toBeWithinRange,
    // @ts-expect-error - TypeScript doesn't recognize the custom matchers.
    toRepeatStringTimes,
});

// Reduce the retry timeout to speed up the tests.
jest.mock('async-retry', () => {
    const original = jest.requireActual('async-retry');
    return jest.fn((callback, options) => {
        return original(callback, {
            ...options,
            minTimeout: 0,
            maxTimeout: 1,
        });
    });
});

// globalSetup scrubs the env that workers and child processes inherit; this repeats it for test
// code, in case a run overrides globalSetup. It runs before test files' module and describe scopes,
// and is never restored: each test file gets its own process.env copy, so restoring would only
// re-expose the removed variables to teardown.
scrubEnv();

// Also runs in afterAll; this call catches the copies of nock an earlier file loaded after that.
resetSharedHttpPatches();

beforeAll(() => {
    const nock = jest.requireActual('nock');
    // Do not send any HTTP requests.
    nock.disableNetConnect();

    // Protect timing functions from Jest's globalsCleanup since nock and other
    // libraries need them. Without this, we get JEST-01 deprecation warnings in CI.
    protectProperties(Date, ['now']);
    protectProperties(performance, ['now']);
    // Protect HTTP/HTTPS modules that nock patches to prevent warnings about internal properties.
    protectProperties(http, ['request', 'get']);
    protectProperties(https, ['request', 'get']);
});

afterAll(async () => {
    // nock's interceptors register on the global object, so Jest soft-deletes them once this file
    // ends; a request still in flight would then print a JEST-01 warning into the next test file.
    // Protect them before restore() takes them off the global object.
    protectInterceptors(global, protectProperties);
    const restoreHttp = async () => {
        const nock = jest.requireActual('nock');
        nock.cleanAll();
        nock.restore();
        resetSharedHttpPatches();
    };
    const cleanUpWorkingDirs = async () => {
        // Loaded here rather than imported, so a test file's jest.mock('fs/promises') still applies
        // to its own copy of @dd/core/helpers/fs.
        const { cleanupEverything } =
            jest.requireActual<typeof import('./helpers/cleanups')>('./helpers/cleanups.ts');
        await cleanupEverything();
    };
    // Both always run, and neither one's error hides the other's.
    const restoring = restoreHttp();
    const cleaning = cleanUpWorkingDirs();
    const results = await Promise.allSettled([restoring, cleaning]);
    const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length) {
        const failureMessages = failures.map(String).join('\n');
        throw new AggregateError(failures, `setupAfterEnv's afterAll failed:\n${failureMessages}`);
    }
});

// Have a less verbose, console.log output.
// Only if we don't pass Jest's --silent flag.
if (!process.env.JEST_SILENT) {
    global.console = console;
}
