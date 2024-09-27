// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { truncateString } from '@dd/core/helpers';
import type { MatcherFunction } from 'expect';

export const toRepeatStringRange: MatcherFunction<[st: string, range: [number, number]]> =
    // `st` and `occurences` get types from the line above
    function toRepeatStringRange(actual, st, range) {
        if (typeof actual !== 'string' || typeof st !== 'string') {
            throw new TypeError('Only works with strings.');
        }
        if (!Array.isArray(range) || range.length !== 2) {
            throw new TypeError('Need an array of two numbers for "range".');
        }

        const result = actual.split(st).length - 1;
        const pass = result <= range[1] && result >= range[0];

        const time = (num: number) => (num > 1 ? 'times' : 'time');
        const failure = !pass
            ? `\nBut got it ${this.utils.printReceived(result)} ${time(result)}.`
            : '.';
        const expected = this.utils.printReceived(truncateString(actual).replace(/\n/g, ' '));

        const message = `Expected: ${expected}
To repeat ${this.utils.printExpected(st)}
Between ${this.utils.printExpected(`${range[0]} and ${range[1]}`)} times${failure}`;

        return {
            message: () => message,
            pass,
        };
    };
