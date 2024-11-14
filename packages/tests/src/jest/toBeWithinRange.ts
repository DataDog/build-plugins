// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { MatcherFunction } from 'expect';

export const toBeWithinRange: MatcherFunction<[floor: number, ceiling: number]> =
    // `floor` and `ceiling` get types from the line above
    function toBeWithinRange(actual, floor, ceiling) {
        if (
            typeof actual !== 'number' ||
            typeof floor !== 'number' ||
            typeof ceiling !== 'number'
        ) {
            throw new TypeError('Must be numbers.');
        }

        return {
            message: () =>
                `Expected ${this.utils.printReceived(actual)}
To be within range ${this.utils.printExpected(`[${floor} ... ${ceiling}]`)}`,
            pass: actual >= floor && actual <= ceiling,
        };
    };
