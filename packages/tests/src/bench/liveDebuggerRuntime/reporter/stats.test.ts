// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    getCounterbalancedVariantOrder,
    getCounterbalancingPeriod,
    roundSamplesToCounterbalancingPeriod,
} from '../project/harness';

import type { BenchQuality, QualityInputs } from './stats';
import {
    autocorrelation,
    bcaConfidenceInterval,
    bcaIndexConfidenceInterval,
    createDeterministicRandom,
    getQuality,
    madOutlierFraction,
    median,
    movingBlockBootstrapConfidenceInterval,
    movingBlockIndexBootstrapConfidenceInterval,
    normalCdf,
    normalQuantile,
    pick,
    percentile,
    trimmedMean,
} from './stats';

type TestVariant = {
    id: string;
    fn: () => number;
};

describe('Live Debugger runtime benchmark stats', () => {
    describe('median', () => {
        const cases = [
            {
                description: 'returns the middle value for odd-length input',
                values: [9, 1, 5],
                expected: 5,
            },
            {
                description: 'averages the middle values for even-length input',
                values: [10, 2, 6, 4],
                expected: 5,
            },
        ];

        test.each(cases)('should $description', ({ values, expected }) => {
            expect(median(values)).toBe(expected);
        });
    });

    describe('percentile', () => {
        const cases = [
            {
                description: 'clamps the zero percentile to the first value',
                percentileRank: 0,
                expected: 1,
            },
            {
                description: 'returns an interpolated percentile',
                percentileRank: 75,
                expected: 7.5,
            },
            {
                description: 'clamps ranks above one hundred to the last value',
                percentileRank: 101,
                expected: 9,
            },
        ];

        test.each(cases)('should $description', ({ percentileRank, expected }) => {
            expect(percentile([9, 1, 3, 7], percentileRank)).toBe(expected);
        });
    });

    describe('trimmedMean', () => {
        const cases = [
            {
                description: 'trims both tails before averaging',
                values: [100, 1, 2, 3, 4],
                trimFraction: 0.2,
                expected: 3,
            },
            {
                description: 'falls back to the full sample when trimming removes everything',
                values: [2, 4],
                trimFraction: 0.5,
                expected: 3,
            },
        ];

        test.each(cases)('should $description', ({ values, trimFraction, expected }) => {
            expect(trimmedMean(values, trimFraction)).toBe(expected);
        });
    });

    describe('madOutlierFraction', () => {
        const cases = [
            {
                description: 'reports the scaled-MAD diagnostic fraction',
                values: [10, 11, 12, 13, 100],
                expected: 0.2,
            },
            {
                description: 'counts a single off-median spike when MAD implodes to zero',
                values: [5, 5, 5, 50],
                expected: 0.25,
            },
            {
                description: 'counts a clustered off-mode when MAD implodes to zero',
                values: [5, 5, 5, 5, 5, 5, 5, 50, 50, 50],
                expected: 0.3,
            },
            {
                description: 'reports the busier tail rather than pooling both tails',
                values: [-100, 1, 2, 3, 4, 5, 6, 7, 8, 100],
                expected: 0.1,
            },
            {
                description: 'returns zero when every sample is identical',
                values: [5, 5, 5, 5],
                expected: 0,
            },
        ];

        test.each(cases)('should $description', ({ values, expected }) => {
            expect(madOutlierFraction(values)).toBe(expected);
        });
    });

    describe('createDeterministicRandom', () => {
        test('should return the same sequence for the same seed', () => {
            const left = createDeterministicRandom(123);
            const right = createDeterministicRandom(123);
            const leftValues = [left(), left(), left()];
            const rightValues = [right(), right(), right()];

            expect(leftValues).toEqual(rightValues);
        });

        test('should use the pinned deterministic sequence', () => {
            const random = createDeterministicRandom(123);
            const values = [random(), random(), random()];

            expect(values).toEqual([0.47988681646529585, 0.06268894905224442, 0.463917750865221]);
        });
    });

    describe('bcaConfidenceInterval', () => {
        test('should return a stable interval for a fixed seed', () => {
            const interval = bcaConfidenceInterval([1, 2, 3, 4, 5], 200, 42);

            expect(interval).toEqual({
                low: 1.563081445492187,
                high: 4.333333333333333,
            });
        });
    });

    describe('movingBlockBootstrapConfidenceInterval', () => {
        test('should return a stable interval for a fixed seed and block length', () => {
            const interval = movingBlockBootstrapConfidenceInterval([1, 2, 3, 4, 5], 200, 42, 2);

            expect(interval).toEqual({
                low: 1.6666666666666667,
                high: 4.333333333333333,
            });
        });
    });

    describe('paired ratio confidence intervals', () => {
        const leftValues = [1, 2, 3, 4, 5];
        const rightValues = [10, 10, 11, 11, 12];
        const ratioEstimator = (indices: number[]) => {
            const leftSample = pick(leftValues, indices);
            const rightSample = pick(rightValues, indices);

            return (trimmedMean(leftSample, 0.2) / trimmedMean(rightSample, 0.2)) * 100;
        };

        test('should resample paired rows for BCa intervals', () => {
            const interval = bcaIndexConfidenceInterval(
                leftValues.length,
                200,
                42,
                0.95,
                ratioEstimator,
            );

            expect(interval).toEqual({
                low: 16.129032258064516,
                high: 38.23529411764706,
            });
        });

        test('should resample paired rows for moving-block intervals', () => {
            const interval = movingBlockIndexBootstrapConfidenceInterval(
                leftValues.length,
                200,
                42,
                2,
                0.95,
                ratioEstimator,
            );

            expect(interval).toEqual({
                low: 16.666666666666668,
                high: 38.23529411764706,
            });
        });
    });

    describe('normalCdf and normalQuantile', () => {
        test('should approximate standard normal values', () => {
            expect(normalCdf(0)).toBeCloseTo(0.5, 8);
            expect(normalQuantile(0.975)).toBeCloseTo(1.959963986120195, 12);
        });
    });

    describe('autocorrelation', () => {
        test('should compute lagged sample correlation against the full-series variance', () => {
            expect(autocorrelation([1, 2, 3, 4], 1)).toBe(0.25);
        });

        test('should return zero for invalid lags', () => {
            expect(autocorrelation([1, 2, 3], 0)).toBe(0);
            expect(autocorrelation([1, 2, 3], 3)).toBe(0);
        });
    });

    describe('getQuality', () => {
        // All intervals are per-call overhead in ns; OVERHEAD_RESOLUTION_NS is
        // 0.5, so an effect below ~0.5 ns/call is treated as unresolvable.
        const cleanInterval = { low: -0.4, high: 0.3 };
        const cleanInputs: QualityInputs = {
            direct: cleanInterval,
            block: cleanInterval,
            aaFloor: cleanInterval,
            outlierFraction: 0.02,
        };
        const cases: { description: string; inputs: QualityInputs; expected: BenchQuality }[] = [
            {
                description: 'reports clean when every diagnostic passes',
                inputs: cleanInputs,
                expected: { level: 'clean', reasons: [] },
            },
            {
                description:
                    'flags A/A drift as unreliable when the apparatus bias rivals a resolved effect',
                inputs: {
                    ...cleanInputs,
                    aaFloor: { low: 0.8, high: 1.2 },
                    direct: { low: 0.6, high: 1 },
                    block: { low: 0.6, high: 1 },
                },
                expected: { level: 'unreliable', reasons: ['A/A drift'] },
            },
            {
                description:
                    'stays clean when a resolved A/A floor is negligible against the effect',
                inputs: {
                    ...cleanInputs,
                    aaFloor: { low: 0.01, high: 0.03 },
                    direct: { low: 43, high: 44 },
                    block: { low: 43, high: 44 },
                },
                expected: { level: 'clean', reasons: [] },
            },
            {
                description: 'cautions when a resolved A/A floor reaches half the effect',
                inputs: {
                    ...cleanInputs,
                    aaFloor: { low: 0.6, high: 1 },
                    direct: { low: 1.8, high: 2 },
                    block: { low: 1.8, high: 2 },
                },
                expected: { level: 'caution', reasons: ['A/A drift'] },
            },
            {
                description:
                    'flags A/A drift when the apparatus bias clears the floor but the effect does not',
                inputs: {
                    ...cleanInputs,
                    aaFloor: { low: 0.6, high: 0.9 },
                    direct: { low: -0.1, high: 0.1 },
                    block: { low: -0.1, high: 0.1 },
                },
                expected: { level: 'unreliable', reasons: ['A/A drift'] },
            },
            {
                description:
                    'flags a confident speed-up past the floor as negative overhead even inside a wide A/A floor',
                inputs: {
                    ...cleanInputs,
                    aaFloor: { low: -0.6, high: 0.6 },
                    direct: { low: -1.5, high: -0.8 },
                    block: { low: -1.6, high: -0.9 },
                },
                expected: { level: 'unreliable', reasons: ['negative overhead'] },
            },
            {
                description:
                    'stays clean on a sub-floor confident speed-up (cross-bundle layout noise)',
                inputs: {
                    ...cleanInputs,
                    aaFloor: { low: -0.06, high: 0.05 },
                    direct: { low: -0.16, high: -0.05 },
                    block: { low: -0.15, high: -0.05 },
                },
                expected: { level: 'clean', reasons: [] },
            },
            {
                description:
                    'stays clean when both the sub-floor effect and a resolved A/A floor are below the floor',
                inputs: {
                    ...cleanInputs,
                    aaFloor: { low: 0.001, high: 0.115 },
                    direct: { low: -0.16, high: -0.05 },
                    block: { low: -0.15, high: -0.05 },
                },
                expected: { level: 'clean', reasons: [] },
            },
            {
                description: 'stays clean when a wide negative tail still brackets zero',
                inputs: {
                    ...cleanInputs,
                    aaFloor: { low: -0.02, high: 0.02 },
                    direct: { low: -0.5, high: 0.05 },
                },
                expected: { level: 'clean', reasons: [] },
            },
            {
                description: 'stays clean on a moderate outlier fraction the trim absorbs',
                inputs: { ...cleanInputs, outlierFraction: 0.15 },
                expected: { level: 'clean', reasons: [] },
            },
            {
                description: 'escalates an outlier fraction at the trim fraction to unreliable',
                inputs: { ...cleanInputs, outlierFraction: 0.2 },
                expected: { level: 'unreliable', reasons: ['outliers'] },
            },
            {
                description: 'stays clean on autocorrelation alone when the intervals agree',
                inputs: {
                    ...cleanInputs,
                    direct: { low: 9.1, high: 9.3 },
                    block: { low: 9, high: 9.4 },
                },
                expected: { level: 'clean', reasons: [] },
            },
            {
                description:
                    'cautions when the block interval disagrees on bracketing zero for a resolved effect',
                inputs: {
                    ...cleanInputs,
                    direct: { low: -0.4, high: 0.7 },
                    block: { low: 0.6, high: 0.9 },
                },
                expected: { level: 'caution', reasons: ['block disagreement'] },
            },
            {
                description: 'lists the most severe reason first when several fire',
                inputs: {
                    ...cleanInputs,
                    aaFloor: { low: 0.8, high: 1.2 },
                    direct: { low: 0.6, high: 1 },
                    block: { low: 0.6, high: 1 },
                    outlierFraction: 0.2,
                },
                expected: { level: 'unreliable', reasons: ['A/A drift', 'outliers'] },
            },
        ];

        test.each(cases)('should $description', ({ inputs, expected }) => {
            expect(getQuality(inputs)).toEqual(expected);
        });
    });

    describe('counterbalanced variant order', () => {
        const variants: TestVariant[] = [
            { id: 'baseline', fn: () => 0 },
            { id: 'control', fn: () => 0 },
            { id: 'instrumented', fn: () => 0 },
        ];

        test('should round sample counts to the full counterbalancing period', () => {
            expect(getCounterbalancingPeriod(variants.length)).toBe(6);
            expect(roundSamplesToCounterbalancingPeriod(100, variants.length)).toBe(102);
            expect(roundSamplesToCounterbalancingPeriod(33, variants.length)).toBe(36);
        });

        test('should put every variant in every position across one rotation cycle', () => {
            const positions = variants.map((variant) => {
                return {
                    id: variant.id,
                    indexes: [0, 1, 2].map((sampleIndex) => {
                        const order = getCounterbalancedVariantOrder(
                            variants,
                            sampleIndex,
                        ) as TestVariant[];

                        return order.findIndex((candidate) => candidate.id === variant.id);
                    }),
                };
            });

            expect(positions).toEqual([
                { id: 'baseline', indexes: [0, 2, 1] },
                { id: 'control', indexes: [1, 0, 2] },
                { id: 'instrumented', indexes: [2, 1, 0] },
            ]);
        });
    });
});
