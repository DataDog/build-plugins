// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createRandom, shuffle } from './random';
import { compareMedians, median, quantile, summarizeMetric } from './statistics';

describe('runtime statistics', () => {
    const quantileCases = [
        { description: 'take the middle of an odd count', values: [3, 1, 2], q: 0.5, expected: 2 },
        {
            description: 'interpolate the middle of an even count',
            values: [4, 1, 3, 2],
            q: 0.5,
            expected: 2.5,
        },
        { description: 'interpolate p75', values: [1, 2, 3, 4, 5], q: 0.75, expected: 4 },
        { description: 'interpolate between ranks', values: [10, 20], q: 0.75, expected: 17.5 },
        { description: 'return the only value', values: [7], q: 0.75, expected: 7 },
    ];

    test.each(quantileCases)('should $description', ({ values, q, expected }) => {
        expect(quantile(values, q)).toBe(expected);
    });

    test('should not reorder its input', () => {
        const values = [3, 1, 2];
        median(values);
        expect(values).toEqual([3, 1, 2]);
    });

    test('should summarize a metric with its median, p75 and count', () => {
        expect(summarizeMetric([100, 300, 200, 400])).toEqual({ median: 250, p75: 325, n: 4 });
        expect(summarizeMetric([])).toBeNull();
    });

    test('should compare medians with a bootstrap interval around the difference', () => {
        const control = [100, 102, 98, 101, 99, 103, 97, 100];
        const instrumented = control.map((value) => value + 20);
        const comparison = compareMedians({
            control,
            instrumented,
            random: createRandom('seed'),
            resamples: 1_000,
        });

        expect(comparison).toMatchObject({
            control: 100,
            instrumented: 120,
            delta: 20,
            deltaPercent: 20,
        });
        expect(comparison?.deltaCi95Low).toBeLessThanOrEqual(20);
        expect(comparison?.deltaCi95High).toBeGreaterThanOrEqual(20);
        expect(comparison?.deltaCi95Low).toBeGreaterThan(0);
        expect(comparison?.deltaPercentCi95Low).toBeLessThanOrEqual(20);
        expect(comparison?.deltaPercentCi95High).toBeGreaterThanOrEqual(20);
    });

    test('should reproduce the same interval from the same seed', () => {
        const options = {
            control: [5, 9, 7, 6, 8],
            instrumented: [9, 12, 8, 11, 10],
            resamples: 500,
        };
        const first = compareMedians({ ...options, random: createRandom('run-1') });
        const second = compareMedians({ ...options, random: createRandom('run-1') });
        expect(first).toEqual(second);
    });

    test('should leave out the interval with fewer than 3 loads on a side', () => {
        const comparison = compareMedians({
            control: [100, 110],
            instrumented: [120, 130, 140],
            random: createRandom('seed'),
            resamples: 100,
        });
        expect(comparison).toEqual({
            control: 105,
            instrumented: 130,
            delta: 25,
            deltaPercent: (25 / 105) * 100,
            deltaCi95Low: null,
            deltaCi95High: null,
            deltaPercentCi95Low: null,
            deltaPercentCi95High: null,
        });
    });

    test('should leave out percentages when a control median can be 0', () => {
        const comparison = compareMedians({
            control: [0, 0, 0, 10],
            instrumented: [5, 5, 5, 15],
            random: createRandom('seed'),
            resamples: 200,
        });
        expect(comparison).toMatchObject({ delta: 5, deltaPercent: null });
        expect(comparison?.deltaCi95Low).not.toBeNull();
        expect(comparison?.deltaPercentCi95Low).toBeNull();
        expect(comparison?.deltaPercentCi95High).toBeNull();
    });

    test('should compare nothing without loads', () => {
        const comparison = compareMedians({
            control: [],
            instrumented: [1, 2, 3],
            random: createRandom('seed'),
            resamples: 100,
        });
        expect(comparison).toBeNull();
    });
});

describe('runtime randomness', () => {
    test('should draw the same numbers in [0, 1) from the same seed', () => {
        const first = createRandom('seed');
        const second = createRandom('seed');
        const other = createRandom('other seed');
        const draws = Array.from({ length: 100 }, () => first());

        expect(draws).toEqual(Array.from({ length: 100 }, () => second()));
        expect(draws).not.toEqual(Array.from({ length: 100 }, () => other()));
        expect(draws.every((draw) => draw >= 0 && draw < 1)).toBe(true);
    });

    test('should shuffle into a new array with the same values', () => {
        const values = ['a', 'b', 'c', 'd', 'e', 'f'];
        const shuffled = shuffle(values, createRandom('seed'));

        expect(values).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        expect([...shuffled].sort()).toEqual(values);
        expect(shuffle(values, createRandom('seed'))).toEqual(shuffled);
    });

    test('should put every value first about equally often', () => {
        const random = createRandom('fairness');
        const counts = new Map<string, number>();
        for (let draw = 0; draw < 3_000; draw++) {
            const [first] = shuffle(['a', 'b', 'c'], random);
            counts.set(first, (counts.get(first) ?? 0) + 1);
        }
        for (const count of counts.values()) {
            expect(count).toBeGreaterThan(900);
            expect(count).toBeLessThan(1_100);
        }
    });
});
