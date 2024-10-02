// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import console from 'console';
import nock from 'nock';

import { toBeWithinRange } from './helpers/toBeWithinRange.ts';
import { toRepeatStringRange } from './helpers/toRepeatStringRange.ts';
import { toRepeatStringTimes } from './helpers/toRepeatStringTimes.ts';

// Extend Jest's expect with custom matchers.
expect.extend({
    toBeWithinRange,
    toRepeatStringTimes,
    toRepeatStringRange,
});

interface CustomMatchers<R> {
    toBeWithinRange(floor: number, ceiling: number): R;
    toRepeatStringTimes(st: string, occurences: number): R;
    toRepeatStringRange(st: string, range: [number, number]): R;
}

interface NonCustomMatchers {
    toBeWithinRange(floor: number, ceiling: number): number;
    toRepeatStringTimes(st: string, occurences: number): string;
    toRepeatStringRange(st: string, range: [number, number]): string;
}

declare global {
    namespace jest {
        interface Expect extends NonCustomMatchers {}
        interface Matchers<R> extends CustomMatchers<R> {}
        interface InverseAsymmetricMatchers extends NonCustomMatchers {}
        interface AsymmetricMatchers extends NonCustomMatchers {}
    }
}

// Do not send any HTTP requests.
nock.disableNetConnect();

// Have a simpler, less verbose, console.log output.
global.console = console;
