// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

let sink = 0;

// Kept in the browser harness so the benchmark fixture remains self-contained.
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }

    return sorted[mid];
};

const runBatch = (workloadFn, batchSize, sampleIndex) => {
    let localSink = sink;

    for (let i = 0; i < batchSize; i++) {
        localSink += workloadFn(sampleIndex + i);
    }

    sink = localSink;
};

const timeBatch = (workloadFn, batchSize, sampleIndex) => {
    const start = performance.now();
    runBatch(workloadFn, batchSize, sampleIndex);

    return performance.now() - start;
};

const calibrateBatchSize = (variants, options) => {
    let batchSize = options.batchSize;

    for (let attempt = 0; attempt < options.calibrationAttempts; attempt++) {
        const durations = [];
        for (let index = 0; index < variants.length; index++) {
            durations.push(timeBatch(variants[index].fn, batchSize, index));
        }
        // Calibrate against the slowest variant rather than the median. The
        // three variants share one batch size, but two of them run the cheap
        // baseline function, so a median-based target grows the batch until the
        // baseline reaches minBatchMs. The instrumented variant can be an order
        // of magnitude slower, so its batches then run for hundreds of
        // milliseconds and the whole sweep lasts long enough for the
        // instrumented path to drift (JIT warm-up then thermal throttling).
        // That drift does not cancel in the within-sample pairing because the
        // baseline batches stay short, which shows up as severe
        // autocorrelation. Sizing to the slowest variant keeps every batch
        // near the target and the sweep short enough to stay stationary.
        const slowestDuration = Math.max(...durations);

        if (slowestDuration >= options.minBatchMs) {
            return batchSize;
        }

        const multiplier = Math.max(
            2,
            Math.ceil(options.minBatchMs / Math.max(slowestDuration, 0.1)),
        );
        batchSize *= multiplier;
    }

    return batchSize;
};

const warmup = (variants, options) => {
    const start = performance.now();
    let iteration = 0;

    while (performance.now() - start < options.warmupMs) {
        const rotatedVariants = getCounterbalancedVariantOrder(variants, iteration);
        for (const variant of rotatedVariants) {
            runBatch(variant.fn, options.batchSize, iteration);
        }
        iteration += options.batchSize;
    }
};

const rotateVariants = (variants, rotationIndex) => {
    const rotation = rotationIndex % variants.length;

    return variants.slice(rotation).concat(variants.slice(0, rotation));
};

export const getCounterbalancingPeriod = (variantCount) => {
    return 2 * variantCount;
};

export const roundSamplesToCounterbalancingPeriod = (samples, variantCount) => {
    const period = getCounterbalancingPeriod(variantCount);

    return Math.ceil(samples / period) * period;
};

export const getCounterbalancedVariantOrder = (variants, sampleIndex) => {
    const rotation = sampleIndex % variants.length;
    const rotatedVariants = rotateVariants(variants, rotation);

    if (Math.floor(sampleIndex / variants.length) % 2 === 0) {
        return rotatedVariants;
    }

    return [rotatedVariants[0], ...rotatedVariants.slice(1).reverse()];
};

export const runBenchPair = (workload, variants, options = {}) => {
    const benchmarkOptions = {
        warmupMs: options.warmupMs ?? 300,
        batchSize: options.batchSize ?? workload.batchSize,
        calibrationAttempts: options.calibrationAttempts ?? 8,
        minBatchMs: options.minBatchMs ?? 50,
        samples: roundSamplesToCounterbalancingPeriod(options.samples ?? 35, variants.length),
    };
    const counterbalancingPeriod = getCounterbalancingPeriod(variants.length);
    if (benchmarkOptions.samples % counterbalancingPeriod !== 0) {
        throw new Error(
            `Benchmark sample count must be a multiple of the counterbalancing period (${counterbalancingPeriod})`,
        );
    }

    const samplesByVariant = Object.fromEntries(variants.map((variant) => [variant.id, []]));

    warmup(variants, benchmarkOptions);
    benchmarkOptions.batchSize = calibrateBatchSize(variants, benchmarkOptions);
    warmup(variants, benchmarkOptions);

    for (let sampleIndex = 0; sampleIndex < benchmarkOptions.samples; sampleIndex++) {
        const rotatedVariants = getCounterbalancedVariantOrder(variants, sampleIndex);
        for (const variant of rotatedVariants) {
            const elapsedMs = timeBatch(variant.fn, benchmarkOptions.batchSize, sampleIndex);
            samplesByVariant[variant.id].push(elapsedMs);
        }
    }

    const instrumentedCallsPerBatch =
        workload.instrumentedCallsPerInvocation * benchmarkOptions.batchSize;

    return {
        workloadId: workload.id,
        workloadLabel: workload.label,
        batchSize: benchmarkOptions.batchSize,
        instrumentedCallsPerBatch,
        sink,
        variants: Object.fromEntries(
            variants.map((variant) => [
                variant.id,
                {
                    samplesMs: samplesByVariant[variant.id],
                    medianMs: median(samplesByVariant[variant.id]),
                },
            ]),
        ),
    };
};
