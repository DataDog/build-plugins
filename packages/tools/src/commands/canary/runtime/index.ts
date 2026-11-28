// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// The runtime engine: serves builds, loads them in headless Chrome and compares
// their page-load metrics. It imports nothing but Node.js built-ins and its own
// files, and only uses TypeScript that Node.js strips, so another job can copy this
// directory and run it with Node.js 22.18 or later and a Chrome binary, without
// installing anything. Keep it that way: runtime/selfContained.test.ts checks it.

export {
    findInsufficientVariant,
    planLoads,
    RuntimeAbortedError,
    runRuntimeBenchmark,
    RuntimeVariantError,
    summarizeLoads,
} from './benchmark.ts';
export type { PlannedLoad, RuntimeBenchmarkOptions } from './benchmark.ts';
export {
    BLOCK_EXTERNAL_HOSTS_FLAG,
    CHROME_PATH_ENV,
    DEFAULT_CHROME_FLAGS,
    findChrome,
    launchChrome,
} from './chrome.ts';
export type { Chrome, ChromePage } from './chrome.ts';
export { createRandom, hash, shuffle } from './random.ts';
export {
    getCacheControl,
    IMMUTABLE_CACHE_CONTROL,
    REVALIDATE_CACHE_CONTROL,
    startStaticServer,
} from './server.ts';
export type { StaticServer } from './server.ts';
export {
    compareMedians,
    median,
    MIN_SAMPLES_FOR_INTERVAL,
    quantile,
    summarizeMetric,
} from './statistics.ts';
export { RUNTIME_CACHE_STATES, RUNTIME_METRICS } from './types.ts';
export type {
    RuntimeBenchmarkResult,
    RuntimeCacheState,
    RuntimeComparison,
    RuntimeCondition,
    RuntimeCookie,
    RuntimeLoad,
    RuntimeLoadMetrics,
    RuntimeMetric,
    RuntimeMetricSummary,
    RuntimeNetworkThrottling,
    RuntimePage,
    RuntimeRemoteVariant,
    RuntimeServedVariant,
    RuntimeSettings,
    RuntimeVariantComparison,
    RuntimeVariantSummary,
    RuntimeVariantTarget,
} from './types.ts';
