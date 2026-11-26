// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

const HOT_CALLS = 256;

// The harness counterbalances baseline, control, and instrumented over
// 2 * variantCount samples. With 3 variants, the period is 6, so the
// closest complete period above 100 samples is ceil(100 / 6) * 6 = 102.
const WORKLOAD_SAMPLES = 102;

function tinyWorkload(iteration) {
    const value = (iteration + 3) * 1.00001;

    return value;
}

function hotKernel(a, b, c) {
    const blended = a * 1.5 + b - c;
    const folded = (blended * 0.25 + a) % 9_973;

    return folded + b * 0.5;
}

// @dd-no-instrumentation
function hotLoopWorkload(iteration) {
    let acc = 0;
    for (let i = 0; i < HOT_CALLS; i++) {
        acc += hotKernel(iteration + i, acc, i);
    }

    return acc;
}

// Preallocated so the workload measures the instrumented catch and rethrow,
// not Error construction: capturing a stack trace on every call would
// multiply the baseline and add allocation noise without changing the
// overhead being measured.
const THROWN_ERROR = new Error('live-debugger-bench');

// Iterations are never negative, so every call throws.
function throwingKernel(iteration) {
    if (iteration >= 0) {
        throw THROWN_ERROR;
    }

    return iteration;
}

// @dd-no-instrumentation
function throwWorkload(iteration) {
    try {
        return throwingKernel(iteration);
    } catch (error) {
        return error === THROWN_ERROR ? 1 : 0;
    }
}

export const workloads = [
    {
        id: 'tiny',
        label: 'Tiny',
        instrumentedCallsPerInvocation: 1,
        batchSize: 20_000,
        samples: WORKLOAD_SAMPLES,
        fn: tinyWorkload,
    },
    {
        id: 'hot',
        label: 'Hot',
        instrumentedCallsPerInvocation: HOT_CALLS,
        batchSize: 2_000,
        samples: WORKLOAD_SAMPLES,
        fn: hotLoopWorkload,
    },
    {
        id: 'throw',
        label: 'Throw',
        instrumentedCallsPerInvocation: 1,
        batchSize: 2_000,
        samples: WORKLOAD_SAMPLES,
        fn: throwWorkload,
    },
];
