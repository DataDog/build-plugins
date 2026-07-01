// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { TestResult } from '@playwright/test/reporter';

import type { BenchQuality, ConfidenceInterval } from './reporter/stats';

export type BenchVariant = 'baseline' | 'instrumented';

export type BenchVariantId = BenchVariant | 'control';

export type BrowserBenchVariant = {
    id: BenchVariantId;
    fn: (iteration: number) => number;
};

export type BrowserBenchWorkload = {
    id: string;
    label: string;
    batchSize: number;
    instrumentedCallsPerInvocation: number;
    samples: number;
    fn: (iteration: number) => number;
};

export type RawVariantResult = {
    samplesMs: number[];
    medianMs: number;
};

export type RawWorkloadResult = {
    workloadId: string;
    workloadLabel: string;
    batchSize: number;
    instrumentedCallsPerBatch: number;
    sink: number;
    variants: Record<BenchVariantId, RawVariantResult>;
};

export type BrowserBenchApi = {
    runBenchPair: (
        workload: BrowserBenchWorkload,
        variants: BrowserBenchVariant[],
        options?: {
            warmupMs?: number;
            batchSize?: number;
            calibrationAttempts?: number;
            minBatchMs?: number;
            samples?: number;
        },
    ) => RawWorkloadResult;
    workloads: BrowserBenchWorkload[];
};

// Build fingerprint for the fetched CDN bundle. The baked sdkVersion alone is ambiguous
// (the published /v7/ bundle keeps the same release-format version across many builds), so
// we capture the CDN object's publish date and S3 ETag (content hash) to pin the exact
// build that was measured. Required: the benchmark asserts both headers are present when it
// fetches the bundle, mirroring how it asserts the SDK version.
export type SdkBuild = {
    publishedAt: string;
    etag: string;
};

export type RawBenchAttachment = {
    browserName: string;
    sdkVersion: string;
    sdkBuild: SdkBuild;
    results: RawWorkloadResult[];
};

export type MetricUnit = {
    point: number;
    direct: ConfidenceInterval;
    block: ConfidenceInterval;
    aaFloor: ConfidenceInterval;
    upperBound: number;
};

export type BenchResultRow = {
    browserName: string;
    workloadId: string;
    workloadLabel: string;
    batchSize: number;
    instrumentedCallsPerBatch: number;
    baseline: RawVariantResult;
    control: RawVariantResult;
    instrumented: RawVariantResult;
    perCallNs: MetricUnit;
    overheadUpperPercent: number;
    sampleCount: number;
    trimFraction: number;
    outlierFraction: number;
    lag1Autocorrelation: number;
    quality: BenchQuality;
};

export type BenchFailure = {
    projectName: string;
    title: string;
    status: TestResult['status'];
    error: string;
};
