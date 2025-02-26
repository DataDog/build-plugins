// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import console from 'console';

import { toBeWithinRange } from './toBeWithinRange.ts';
import { toRepeatStringTimes } from './toRepeatStringTimes.ts';

// Extend Jest's expect with custom matchers.
expect.extend({
    toBeWithinRange,
    toRepeatStringTimes,
});

interface CustomMatchers<R> {
    toBeWithinRange(floor: number, ceiling: number): R;
    toRepeatStringTimes(st: string | RegExp, occurences: number | [number, number]): R;
}

interface NonCustomMatchers {
    toBeWithinRange(floor: number, ceiling: number): number;
    toRepeatStringTimes(st: string | RegExp, occurences: number | [number, number]): string;
}

declare global {
    namespace jest {
        interface Expect extends NonCustomMatchers {}
        interface Matchers<R> extends CustomMatchers<R> {}
        interface InverseAsymmetricMatchers extends NonCustomMatchers {}
        interface AsymmetricMatchers extends NonCustomMatchers {}
    }
}

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

beforeAll(() => {
    const nock = jest.requireActual('nock');
    // Do not send any HTTP requests.
    nock.disableNetConnect();
});

afterAll(async () => {
    // Clean the workingDirs from runBundlers();
    const { cleanupEverything } = jest.requireActual('./helpers/runBundlers.ts');
    await cleanupEverything();
});

// Have a less verbose, console.log output.
// Only if we don't pass Jest's --silent flag.
if (!process.env.JEST_SILENT) {
    global.console = console;
}
