// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export const RUNTIME_CACHE_STATES = ['cold', 'warm'] as const;
export type RuntimeCacheState = (typeof RUNTIME_CACHE_STATES)[number];

// Every metric's name ends with its unit.
export const RUNTIME_METRICS = [
    'fcpMs',
    'lcpMs',
    'scriptMs',
    'blockingBeforeLcpMs',
    'jsTransferBytes',
    'jsDecodedBytes',
] as const;
export type RuntimeMetric = (typeof RUNTIME_METRICS)[number];
export type RuntimeLoadMetrics = Record<RuntimeMetric, number | null>;

export type RuntimePage = {
    // Stable, low-cardinality name for reports and metric tags, for example `home`.
    id: string;
    // Path to load, resolved against the variant's origin. An absolute URL also works.
    path: string;
    // CSS selector of an element that is visible once the page has rendered.
    readySelector: string;
};

// Set before every navigation, in the shape of CDP's Network.CookieParam.
export type RuntimeCookie = {
    name: string;
    value: string;
    url?: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
};

// A build the engine serves from a local directory...
export type RuntimeServedVariant<V extends string> = {
    id: V;
    root: string;
    // URL paths of files whose names change with their content. They get a
    // year-long max-age; everything else is revalidated on every load.
    immutablePaths: RegExp;
    cookies?: RuntimeCookie[];
};

// ...or one that something else serves.
export type RuntimeRemoteVariant<V extends string> = {
    id: V;
    origin: string;
    cookies?: RuntimeCookie[];
};

export type RuntimeVariantTarget<V extends string> =
    | RuntimeServedVariant<V>
    | RuntimeRemoteVariant<V>;

export type RuntimeNetworkThrottling = {
    downloadMbps: number;
    uploadMbps: number;
    latencyMs: number;
};

export type RuntimeSettings = {
    repetitions: number;
    // CPU slowdown factors, 1 for none. Each is a separate condition.
    cpuThrottlingRates: number[];
    // Applied to every measured load; null for none.
    network: RuntimeNetworkThrottling | null;
    // A load ends once no new LCP candidate has appeared for this long...
    lcpSettleMs: number;
    // ...or once this long has passed since navigation started.
    maxWaitMs: number;
    bootstrapResamples: number;
};

// One measured page load.
export type RuntimeLoad<V extends string> = {
    repetition: number;
    variant: V;
    page: string;
    cache: RuntimeCacheState;
    cpuThrottling: number;
    // False when the load failed, or FCP or LCP is missing. Failed loads are left
    // out of the statistics.
    ok: boolean;
    error: string | null;
    metrics: RuntimeLoadMetrics;
    jsRequests: number;
    // Uncaught exceptions on the page.
    pageErrors: number;
    // Requests to the variant's origin that failed or got a 4xx or 5xx status.
    failedRequests: number;
};

export type RuntimeMetricSummary = {
    median: number;
    p75: number;
    n: number;
};

export type RuntimeVariantSummary<V extends string> = {
    variant: V;
    loads: number;
    failedLoads: number;
    metrics: Record<RuntimeMetric, RuntimeMetricSummary | null>;
};

// `control` and `instrumented` are medians. The 95% intervals are null with fewer
// than 3 loads on a side, and the percentage ones also when a control median is 0.
export type RuntimeComparison = {
    control: number;
    instrumented: number;
    delta: number;
    deltaPercent: number | null;
    deltaCi95Low: number | null;
    deltaCi95High: number | null;
    deltaPercentCi95Low: number | null;
    deltaPercentCi95High: number | null;
};

export type RuntimeVariantComparison<V extends string> = {
    variant: V;
    metrics: Record<RuntimeMetric, RuntimeComparison | null>;
};

// The loads of one page, in one cache state, at one CPU throttling rate.
export type RuntimeCondition<V extends string> = {
    page: string;
    cache: RuntimeCacheState;
    cpuThrottling: number;
    variants: RuntimeVariantSummary<V>[];
    // Each variant but control, against control.
    comparisons: RuntimeVariantComparison<V>[];
};

export type RuntimeBenchmarkResult<V extends string> = {
    browser: {
        version: string;
    };
    durationMs: number;
    pages: Array<Pick<RuntimePage, 'id' | 'path'>>;
    conditions: RuntimeCondition<V>[];
    loads: RuntimeLoad<V>[];
};
