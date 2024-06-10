// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { formatDuration } from '@dd/core/helpers';

describe('Core Helpers', () => {
    test.each([
        [10, '10ms'],
        [10010, '10s 10ms'],
        [1000010, '16m 40s 10ms'],
        [10000010, '2h 46m 40s 10ms'],
        [1000000010, '11d 13h 46m 40s 10ms'],
    ])('It should format duration', async (ms, expected) => {
        expect(formatDuration(ms)).toBe(expected);
    });
});
