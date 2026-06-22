// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export const BOOTSTRAP_ITERATIONS = 10_000;
export const MAD_OUTLIER_MULTIPLIER = 3;
export const MAD_NORMAL_SCALE = 1.4826;
export const TRIM_FRACTION = 0.2;

// Quality is judged on the per-call nanosecond scale, not on percent. The
// benchmark's headline metric is overhead per instrumented call, and the noise
// it has to tolerate -- cross-bundle code layout, JIT codegen, timer
// granularity -- is fundamentally an absolute per-call quantity. Percent hides
// this: on V8 the dormant hooks are nearly free, so `chrome/Tiny` (a genuine
// ~0.15 ns/call effect) and `chrome/Hot` (a genuine ~3.6 ns/call effect) both
// read as ~3.5% because the Tiny baseline per call is tiny. No percentage
// threshold can separate the 0.15 ns noise from the 3.6 ns signal; the ns scale
// separates them trivially.
//
// Below this floor a per-call effect cannot be distinguished from cross-bundle
// layout noise: the baseline and instrumented bundles are built separately, so
// their "same" code differs in layout, and that difference (a fraction of a CPU
// cycle per call) makes the measured overhead drift by a sub-nanosecond amount
// in either direction around a true ~zero effect. ~0.5 ns is roughly one to two
// cycles on a multi-GHz core; the smallest genuinely-resolved overhead we see
// (firefox/Tiny, ~1.7 ns) sits comfortably above it.
export const OVERHEAD_RESOLUTION_NS = 0.5;

// Once the effect clears the resolution floor it is real, and the A/A floor
// (control vs. baseline, same code) -- the apparatus's own order/scheduling
// bias -- is weighed against it as a fraction rather than tested against a hard
// zero. Below the caution ratio the resolved bias is negligible against the
// effect; at or above the severe ratio the apparatus bias is as large as the
// effect and the row cannot be trusted.
export const AA_DRIFT_CAUTION_RATIO = 0.5;
export const AA_DRIFT_SEVERE_RATIO = 1;

// The per-tail MAD outlier fraction (see madOutlierFraction) is only acted on
// once it reaches the trim fraction, because that is exactly the 20%
// trimmed-mean estimator's per-tail breakdown point: below it the trim absorbs
// the outliers on that side without bias, at or beyond it the outliers start
// surviving the trim and moving the point estimate itself.
export const MAD_SEVERE_FRACTION = TRIM_FRACTION;

export type ConfidenceInterval = {
    low: number;
    high: number;
};

export type BenchQualityLevel = 'clean' | 'caution' | 'unreliable';

export type BenchQualityFlag =
    | 'A/A drift'
    | 'negative overhead'
    | 'outliers'
    | 'block disagreement';

export type BenchQuality = {
    level: BenchQualityLevel;
    reasons: BenchQualityFlag[];
};

// All three intervals are per-call overhead in nanoseconds (see
// OVERHEAD_RESOLUTION_NS for why the ns scale, not percent, is the right one to
// judge quality on): `direct`/`block` are the naive and dependence-robust
// `instrumented - control` intervals, `aaFloor` is the `control - baseline`
// apparatus floor.
export type QualityInputs = {
    direct: ConfidenceInterval;
    block: ConfidenceInterval;
    aaFloor: ConfidenceInterval;
    outlierFraction: number;
};

export type Estimator = (values: number[]) => number;

export type IndexEstimator = (indices: number[]) => number;

type IndexResampler = (sampleCount: number, random: () => number) => number[];

export const percentile = (values: number[], percentileRank: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 0) {
        throw new Error('Cannot compute a percentile of an empty sample');
    }

    if (percentileRank <= 0) {
        return sorted[0];
    }

    if (percentileRank >= 100) {
        return sorted[sorted.length - 1];
    }

    const rank = (percentileRank / 100) * (sorted.length - 1);
    const lowerIndex = Math.floor(rank);
    const upperIndex = Math.ceil(rank);
    const fraction = rank - lowerIndex;

    return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * fraction;
};

export const mean = (values: number[]) => {
    if (values.length === 0) {
        throw new Error('Cannot compute a mean of an empty sample');
    }

    return values.reduce((sum, value) => sum + value, 0) / values.length;
};

export const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 0) {
        throw new Error('Cannot compute a median of an empty sample');
    }

    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }

    return sorted[mid];
};

export const trimmedMean = (values: number[], trimFraction: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    const trimCount = Math.floor(sorted.length * trimFraction);
    const trimmed = sorted.slice(trimCount, sorted.length - trimCount);

    return mean(trimmed.length > 0 ? trimmed : sorted);
};

// The fraction of samples in the busier tail that sit beyond 3 scaled-MADs of
// the median. It is measured per tail rather than pooled across both, because
// the point estimate is a 20% trimmed mean: it trims each end independently and
// stays unbiased as long as neither tail's contamination exceeds the trim
// fraction. The worst single tail is therefore what decides whether the
// estimate is still trustworthy -- a symmetric spread of, say, 12% per side
// (24% pooled) is fully absorbed by the trim, while 24% on one side is not.
export const madOutlierFraction = (values: number[]) => {
    const medianValue = median(values);
    const deviations = values.map((value) => Math.abs(value - medianValue));
    const scaledMad = median(deviations) * MAD_NORMAL_SCALE;
    const maxDeviation = MAD_OUTLIER_MULTIPLIER * scaledMad;

    // The MAD implodes to zero once more than half the samples sit on the
    // median, which is common with quantized browser timings. In that shape any
    // non-median sample is outside the robust central mass, so count it directly
    // instead of letting an off-mode cluster inflate its own spread estimate.
    const isOutlier = (value: number) => {
        return scaledMad === 0
            ? value !== medianValue
            : Math.abs(value - medianValue) > maxDeviation;
    };

    let upperTail = 0;
    let lowerTail = 0;
    for (const value of values) {
        if (!isOutlier(value)) {
            continue;
        }
        if (value > medianValue) {
            upperTail++;
        } else {
            lowerTail++;
        }
    }

    return Math.max(upperTail, lowerTail) / values.length;
};

export const createDeterministicRandom = (seed: number) => {
    const mash = createMash();
    let state0 = mash(' ');
    let state1 = mash(' ');
    let state2 = mash(' ');
    state0 -= mash(seed.toString());
    if (state0 < 0) {
        state0 += 1;
    }
    state1 -= mash(seed.toString());
    if (state1 < 0) {
        state1 += 1;
    }
    state2 -= mash(seed.toString());
    if (state2 < 0) {
        state2 += 1;
    }
    let carry = 1;

    return () => {
        const nextValue = 2_091_639 * state0 + carry * 2.328_306_436_538_696_3e-10;
        state0 = state1;
        state1 = state2;
        carry = Math.floor(nextValue);
        state2 = nextValue - carry;

        return state2;
    };
};

const createMash = () => {
    let state = 4_022_871_197;

    return (value: string) => {
        for (let index = 0; index < value.length; index++) {
            state += value.charCodeAt(index);
            let hash = 0.025_196_032_824_169_38 * state;
            state = Math.floor(hash);
            hash -= state;
            hash *= state;
            state = Math.floor(hash);
            hash -= state;
            state += hash * 4_294_967_296;
        }

        const unsignedState = state < 0 ? state + 4_294_967_296 : state;

        return (unsignedState % 4_294_967_296) * 2.328_306_436_538_696_3e-10;
    };
};

export const hashString = (value: string) => {
    let hash = 0;

    for (let i = 0; i < value.length; i++) {
        hash = (hash * 31 + value.charCodeAt(i)) % 4_294_967_296;
    }

    return hash;
};

export const normalCdf = (value: number) => {
    const sign = value < 0 ? -1 : 1;
    const x = Math.abs(value) / Math.sqrt(2);
    const t = 1 / (1 + 0.3275911 * x);
    const coefficients = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
    const polynomial = coefficients.reduceRight((accumulator, coefficient) => {
        return (accumulator + coefficient) * t;
    }, 0);
    const erf = sign * (1 - polynomial * Math.exp(-x * x));

    return 0.5 * (1 + erf);
};

export const normalQuantile = (probability: number) => {
    if (probability <= 0 || probability >= 1) {
        throw new Error('Normal quantile probability must be between 0 and 1');
    }

    const a = [
        -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
        -3.066479806614716e1, 2.506628277459239,
    ];
    const b = [
        -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
        -1.328068155288572e1,
    ];
    const c = [
        -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
        4.374664141464968, 2.938163982698783,
    ];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const lower = 0.02425;
    const upper = 1 - lower;

    if (probability < lower) {
        const q = Math.sqrt(-2 * Math.log(probability));
        const numerator = ((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5];
        const denominator = (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1;

        return numerator / denominator;
    }

    if (probability > upper) {
        const q = Math.sqrt(-2 * Math.log(1 - probability));
        const numerator = ((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5];
        const denominator = (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1;

        return -(numerator / denominator);
    }

    const q = probability - 0.5;
    const r = q * q;
    const numerator = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q;
    const denominator = ((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1;

    return numerator / denominator;
};

const defaultEstimator: Estimator = (values) => {
    return trimmedMean(values, TRIM_FRACTION);
};

const getConfidenceBounds = (confidenceLevel: number) => {
    const alpha = 1 - confidenceLevel;

    return {
        low: alpha / 2,
        high: 1 - alpha / 2,
    };
};

export const pick = (values: number[], indices: number[]) => {
    return indices.map((index) => values[index]);
};

const createSequentialIndices = (sampleCount: number) => {
    return Array.from({ length: sampleCount }, (_value, index) => index);
};

const resampleIndices: IndexResampler = (sampleCount, random) => {
    const resampled: number[] = [];

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
        resampled.push(Math.floor(random() * sampleCount));
    }

    return resampled;
};

const createMovingBlockIndexResampler = (blockLength: number): IndexResampler => {
    return (sampleCount, random) => {
        const resampled: number[] = [];
        const normalizedBlockLength = Math.max(1, Math.min(sampleCount, Math.round(blockLength)));

        while (resampled.length < sampleCount) {
            const blockStart = Math.floor(random() * sampleCount);
            for (let offset = 0; offset < normalizedBlockLength; offset++) {
                resampled.push((blockStart + offset) % sampleCount);

                if (resampled.length === sampleCount) {
                    break;
                }
            }
        }

        return resampled;
    };
};

const createValueEstimator = (values: number[], estimator: Estimator): IndexEstimator => {
    return (indices) => estimator(pick(values, indices));
};

const bootstrapEstimates = (
    sampleCount: number,
    iterations: number,
    seed: number,
    estimator: IndexEstimator,
    resampler: IndexResampler,
) => {
    const random = createDeterministicRandom(seed);
    const estimates: number[] = [];

    for (let iteration = 0; iteration < iterations; iteration++) {
        estimates.push(estimator(resampler(sampleCount, random)));
    }

    return estimates;
};

const getBcaAcceleration = (sampleCount: number, estimator: IndexEstimator) => {
    if (sampleCount < 3) {
        return 0;
    }

    const indices = createSequentialIndices(sampleCount);
    const jackknifeEstimates = indices.map((omittedIndex) => {
        const jackknifeSample = indices.filter((index) => {
            return index !== omittedIndex;
        });

        return estimator(jackknifeSample);
    });
    const jackknifeMean = mean(jackknifeEstimates);
    const numerator = jackknifeEstimates.reduce((sum, estimate) => {
        return sum + (jackknifeMean - estimate) ** 3;
    }, 0);
    const denominatorTerm = jackknifeEstimates.reduce((sum, estimate) => {
        return sum + (jackknifeMean - estimate) ** 2;
    }, 0);

    if (denominatorTerm === 0) {
        return 0;
    }

    return numerator / (6 * denominatorTerm ** 1.5);
};

const getBcaPercentile = (alpha: number, biasCorrection: number, acceleration: number) => {
    const zAlpha = normalQuantile(alpha);
    const numerator = biasCorrection + zAlpha;
    const denominator = 1 - acceleration * numerator;

    if (denominator === 0) {
        return alpha;
    }

    return normalCdf(biasCorrection + numerator / denominator);
};

export const bcaIndexConfidenceInterval = (
    sampleCount: number,
    iterations: number,
    seed: number,
    confidenceLevel: number,
    estimator: IndexEstimator,
    resampler: IndexResampler = resampleIndices,
): ConfidenceInterval => {
    const thetaHat = estimator(createSequentialIndices(sampleCount));
    const estimates = bootstrapEstimates(sampleCount, iterations, seed, estimator, resampler);

    const estimatesBelowTheta = estimates.filter((estimate) => {
        return estimate < thetaHat;
    }).length;
    const biasProbability = (estimatesBelowTheta + 0.5) / (estimates.length + 1);
    const biasCorrection = normalQuantile(biasProbability);
    const acceleration = getBcaAcceleration(sampleCount, estimator);
    const bounds = getConfidenceBounds(confidenceLevel);
    const lowPercentile = getBcaPercentile(bounds.low, biasCorrection, acceleration);
    const highPercentile = getBcaPercentile(bounds.high, biasCorrection, acceleration);

    return {
        low: percentile(estimates, lowPercentile * 100),
        high: percentile(estimates, highPercentile * 100),
    };
};

export const bcaConfidenceInterval = (
    values: number[],
    iterations: number,
    seed: number,
    confidenceLevel = 0.95,
    estimator: Estimator = defaultEstimator,
): ConfidenceInterval => {
    return bcaIndexConfidenceInterval(
        values.length,
        iterations,
        seed,
        confidenceLevel,
        createValueEstimator(values, estimator),
    );
};

const indexBootstrapConfidenceInterval = (
    sampleCount: number,
    iterations: number,
    seed: number,
    confidenceLevel: number,
    estimator: IndexEstimator,
    resampler: IndexResampler = resampleIndices,
): ConfidenceInterval => {
    const bounds = getConfidenceBounds(confidenceLevel);
    const estimates = bootstrapEstimates(sampleCount, iterations, seed, estimator, resampler);

    return {
        low: percentile(estimates, bounds.low * 100),
        high: percentile(estimates, bounds.high * 100),
    };
};

export const movingBlockIndexBootstrapConfidenceInterval = (
    sampleCount: number,
    iterations: number,
    seed: number,
    blockLength: number,
    confidenceLevel: number,
    estimator: IndexEstimator,
): ConfidenceInterval => {
    const resampler = createMovingBlockIndexResampler(blockLength);

    return indexBootstrapConfidenceInterval(
        sampleCount,
        iterations,
        seed,
        confidenceLevel,
        estimator,
        resampler,
    );
};

export const movingBlockBootstrapConfidenceInterval = (
    values: number[],
    iterations: number,
    seed: number,
    blockLength: number,
    confidenceLevel = 0.95,
    estimator: Estimator = defaultEstimator,
): ConfidenceInterval => {
    return movingBlockIndexBootstrapConfidenceInterval(
        values.length,
        iterations,
        seed,
        blockLength,
        confidenceLevel,
        createValueEstimator(values, estimator),
    );
};

export const autocorrelation = (values: number[], lag: number) => {
    if (lag <= 0 || lag >= values.length) {
        return 0;
    }

    const average = mean(values);
    const denominator = values.reduce((sum, value) => {
        return sum + (value - average) ** 2;
    }, 0);

    if (denominator === 0) {
        return 0;
    }

    let numerator = 0;
    for (let index = 0; index < values.length - lag; index++) {
        numerator += (values[index] - average) * (values[index + lag] - average);
    }

    return numerator / denominator;
};

export const lag1Autocorrelation = (values: number[]) => {
    return autocorrelation(values, 1);
};

const bracketsZero = (interval: ConfidenceInterval) => {
    return interval.low <= 0 && interval.high >= 0;
};

// The largest plausible apparatus bias from the A/A floor: the bound furthest
// from zero, since either tail could be the systematic offset.
const apparatusBiasMagnitude = (aaFloor: ConfidenceInterval) => {
    return Math.max(Math.abs(aaFloor.low), Math.abs(aaFloor.high));
};

// The single definition of the published overhead upper bound: the
// dependence-robust upper bound of the `instrumented - control` effect, floored
// at zero. The reporter's `withUpperBound` derives the displayed number from
// this same helper, so the quality verdict and the printed bound can never
// drift apart.
export const overheadUpperBound = (direct: ConfidenceInterval, block: ConfidenceInterval) => {
    return Math.max(direct.high, block.high, 0);
};

// Aggregates the per-row diagnostics into one plain-language verdict about
// whether the timing apparatus and the sampled `instrumented - control` delta
// are statistically sound. This is orthogonal to how large the overhead is: a
// quiet run whose effect is below the resolution floor is `clean`, while a
// contaminated run is flagged regardless of its number. It does not certify the
// absence of variant-specific bias such as code-layout or inlining differences
// between the two bundles: the A/A floor only re-runs the baseline path, so
// that class of bias is bracketed by the Tiny/Hot workloads, not detected here.
export const getQuality = (inputs: QualityInputs): BenchQuality => {
    const severe: BenchQualityFlag[] = [];
    const caution: BenchQualityFlag[] = [];

    // Everything below is judged in ns/call against OVERHEAD_RESOLUTION_NS. An
    // effect at or above the floor is "resolved": large enough to stand clear
    // of cross-bundle layout noise. Below it the per-call overhead cannot be
    // told apart from that noise, so a small negative excursion or a small
    // resolved A/A floor is the expected ~zero outcome, not a defect.
    const overhead = overheadUpperBound(inputs.direct, inputs.block);
    const overheadResolved = overhead >= OVERHEAD_RESOLUTION_NS;

    // The A/A floor (control vs. baseline) captures the apparatus's own bias.
    // It is expected to resolve to a small non-zero number, so testing it
    // against a hard zero condemns solid runs over picosecond offsets.
    if (!bracketsZero(inputs.aaFloor)) {
        const bias = apparatusBiasMagnitude(inputs.aaFloor);

        if (overheadResolved) {
            // Weigh the resolved bias against the effect it could swamp: a bias
            // far below the effect is harmless, one that rivals it means the
            // session drifted enough to swamp what we are measuring.
            const biasRatio = bias / overhead;
            if (biasRatio >= AA_DRIFT_SEVERE_RATIO) {
                severe.push('A/A drift');
            } else if (biasRatio >= AA_DRIFT_CAUTION_RATIO) {
                caution.push('A/A drift');
            }
        } else if (bias >= OVERHEAD_RESOLUTION_NS) {
            // The effect is below the floor, so there is nothing to weigh the
            // bias against; the floor is only alarming if the apparatus bias
            // itself clears it -- the session drifted by more than a resolvable
            // per-call amount while we could not even resolve the effect.
            severe.push('A/A drift');
        }
    }

    // Instrumentation only adds instructions, so it can never be faster. A
    // confident speed-up (the whole direct interval below zero) is impossible,
    // but only material once it clears the resolution floor: a sub-floor
    // "speed-up" is the cross-bundle layout noise around a true ~zero effect,
    // not contamination, so it stays clean.
    if (inputs.direct.high <= -OVERHEAD_RESOLUTION_NS) {
        severe.push('negative overhead');
    }

    // Only contamination heavy enough to defeat the trimmed-mean estimator is a
    // reliability problem. The fraction is per-tail (the busier side), so a
    // symmetric spread the trim absorbs from both ends stays clean; browsers
    // like WebKit are routinely spiky on the hot path without being unreliable.
    if (inputs.outlierFraction >= MAD_SEVERE_FRACTION) {
        severe.push('outliers');
    }

    // Autocorrelation is not gated on directly: the moving-block bootstrap is
    // the dependence-robust interval and is what the row reports, so stationary
    // autocorrelation (a wander whose mean is still well resolved) is already
    // handled. The lag-1 value is shown as a diagnostic. The check that matters
    // is whether accounting for dependence changes the verdict: if the naive
    // and block intervals disagree on bracketing zero, the naive width lied.
    // Only meaningful once the effect is resolved; below the floor a zero-
    // bracket flip is noise around zero, not a dependence problem.
    if (overheadResolved && bracketsZero(inputs.direct) !== bracketsZero(inputs.block)) {
        caution.push('block disagreement');
    }

    if (severe.length > 0) {
        return { level: 'unreliable', reasons: [...severe, ...caution] };
    }

    if (caution.length > 0) {
        return { level: 'caution', reasons: caution };
    }

    return { level: 'clean', reasons: [] };
};
