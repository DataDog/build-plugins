// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Random } from './random.ts';
import type { RuntimeComparison, RuntimeMetricSummary } from './types.ts';

const CONFIDENCE_LEVEL = 0.95;
const LOWER_TAIL = (1 - CONFIDENCE_LEVEL) / 2;
const UPPER_TAIL = 1 - LOWER_TAIL;

// A confidence interval from fewer samples per side says little.
export const MIN_SAMPLES_FOR_INTERVAL = 3;

// Linear interpolation between the closest ranks, like numpy's default.
export const quantile = (values: readonly number[], probability: number): number => {
    if (values.length === 0) {
        throw new Error('Cannot take the quantile of no values.');
    }
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * probability;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    const lower = sorted[lowerIndex];
    const upper = sorted[upperIndex];
    return lower + (upper - lower) * (position - lowerIndex);
};

export const median = (values: readonly number[]): number => {
    return quantile(values, 0.5);
};

export const summarizeMetric = (values: readonly number[]): RuntimeMetricSummary | null => {
    if (values.length === 0) {
        return null;
    }
    return {
        median: median(values),
        p75: quantile(values, 0.75),
        n: values.length,
    };
};

const resample = (values: readonly number[], random: Random): number[] => {
    return values.map(() => {
        const position = random() * values.length;
        return values[Math.floor(position)];
    });
};

const getPercentChange = (control: number, instrumented: number): number | null => {
    return control === 0 ? null : ((instrumented - control) / control) * 100;
};

// Compares the medians of two independent samples. The 95% intervals come from a
// percentile bootstrap that resamples each side separately.
export const compareMedians = ({
    control,
    instrumented,
    random,
    resamples,
}: {
    control: readonly number[];
    instrumented: readonly number[];
    random: Random;
    resamples: number;
}): RuntimeComparison | null => {
    if (control.length === 0 || instrumented.length === 0) {
        return null;
    }

    const controlMedian = median(control);
    const instrumentedMedian = median(instrumented);
    const comparison: RuntimeComparison = {
        control: controlMedian,
        instrumented: instrumentedMedian,
        delta: instrumentedMedian - controlMedian,
        deltaPercent: getPercentChange(controlMedian, instrumentedMedian),
        deltaCi95Low: null,
        deltaCi95High: null,
        deltaPercentCi95Low: null,
        deltaPercentCi95High: null,
    };
    if (
        control.length < MIN_SAMPLES_FOR_INTERVAL ||
        instrumented.length < MIN_SAMPLES_FOR_INTERVAL ||
        resamples <= 0
    ) {
        return comparison;
    }

    const deltas: number[] = [];
    const percentages: number[] = [];
    for (let iteration = 0; iteration < resamples; iteration++) {
        const controlSample = resample(control, random);
        const instrumentedSample = resample(instrumented, random);
        const controlSampleMedian = median(controlSample);
        const instrumentedSampleMedian = median(instrumentedSample);
        deltas.push(instrumentedSampleMedian - controlSampleMedian);
        const percentage = getPercentChange(controlSampleMedian, instrumentedSampleMedian);
        if (percentage !== null) {
            percentages.push(percentage);
        }
    }

    comparison.deltaCi95Low = quantile(deltas, LOWER_TAIL);
    comparison.deltaCi95High = quantile(deltas, UPPER_TAIL);
    // A resample whose control median is 0 has no percentage, and then neither
    // has the interval.
    if (percentages.length === resamples) {
        comparison.deltaPercentCi95Low = quantile(percentages, LOWER_TAIL);
        comparison.deltaPercentCi95High = quantile(percentages, UPPER_TAIL);
    }
    return comparison;
};
