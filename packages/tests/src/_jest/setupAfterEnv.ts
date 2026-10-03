// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import console from 'console';
import https from 'https';
import http from 'http';
import { protectProperties } from 'jest-util';

import { cleanEnv } from './helpers/cleanEnv.ts';
import { protectInterceptors } from './helpers/protectInterceptors.ts';
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

// Scrubs CI's Datadog credentials and DD_SITE before test files' module and describe scopes run.
// Never restored: each test file gets its own process.env copy, so restoring would only re-expose
// them to teardown.
cleanEnv();

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
    // Clean up nock interceptors before Jest's global cleanup to prevent warnings.
    const nock = jest.requireActual('nock');
    nock.cleanAll();
    nock.restore();
    nock.activate();
    // nock's interceptors register on the global object, so Jest soft-deletes them once this file
    // ends; a request still in flight would then print a JEST-01 warning into the next test file.
    protectInterceptors(global, protectProperties);

    // Clean the workingDirs from runBundlers();
    const { cleanupEverything } = jest.requireActual('./helpers/runBundlers.ts');
    await cleanupEverything();
});

// Have a less verbose, console.log output.
// Only if we don't pass Jest's --silent flag.
if (!process.env.JEST_SILENT) {
    global.console = console;
}
