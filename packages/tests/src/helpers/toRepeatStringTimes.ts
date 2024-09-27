// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { truncateString } from '@dd/core/helpers';
import type { MatcherFunction } from 'expect';

export const toRepeatStringTimes: MatcherFunction<[st: string, occurences: number]> =
    // `st` and `occurences` get types from the line above
    function toRepeatStringTimes(actual, st, occurences) {
        if (typeof actual !== 'string' || typeof st !== 'string') {
            throw new TypeError('Only works with strings.');
        }
        if (typeof occurences !== 'number') {
            throw new TypeError('Need a number here.');
        }

        const result = actual.split(st).length - 1;
        const pass = result === occurences;

        const time = (num: number) => (num > 1 ? 'times' : 'time');
        const failure = !pass
            ? `\nBut got it ${this.utils.printReceived(result)} ${time(result)}.`
            : '';
        const expected = this.utils.printReceived(truncateString(actual).replace(/\n/g, ' '));

        const message = `Expected: ${expected}
To repeat ${this.utils.printExpected(st)}
Exactly ${this.utils.printExpected(occurences)} ${time(occurences)}${failure}.`;

        return {
            message: () => message,
            pass,
        };
    };
