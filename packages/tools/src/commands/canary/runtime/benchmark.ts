// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Chrome } from './chrome.ts';
import { ChromeConnectionError, launchChrome } from './chrome.ts';
import type { LoadResult } from './measure.ts';
import { measureLoad, visitPage } from './measure.ts';
import type { Random } from './random.ts';
import { createRandom, shuffle } from './random.ts';
import type { StaticServer } from './server.ts';
import { startStaticServer } from './server.ts';
import { compareMedians, MIN_SAMPLES_FOR_INTERVAL, summarizeMetric } from './statistics.ts';
import { RUNTIME_CACHE_STATES } from './types.ts';
import type {
    RuntimeBenchmarkResult,
    RuntimeCacheState,
    RuntimeCondition,
    RuntimeLoad,
    RuntimeMetric,
    RuntimePage,
    RuntimeSettings,
    RuntimeVariantTarget,
} from './types.ts';

// Warm loads come after two visits: the first fills the HTTP cache, and V8 only
// writes its code cache for scripts it has seen before.
const WARM_PRIMING_VISITS = 2;
// One visit warms up a fresh browser before its first measured cold load.
const COLD_PRIMING_VISITS = 1;
// The slow loads are the likeliest to fail, so dropping many of them would make a
// variant look faster than it is.
export const MAX_FAILED_LOAD_SHARE = 0.1;

// A variant whose build doesn't load, which says who needs to act.
export class RuntimeVariantError extends Error {
    readonly variant: string;

    constructor(message: string, variant: string) {
        super(message);
        this.variant = variant;
    }
}

export class RuntimeAbortedError extends Error {}

export type PlannedLoad<V extends string> = {
    repetition: number;
    variant: V;
    page: RuntimePage;
    cache: RuntimeCacheState;
    cpuThrottling: number;
};

export type RuntimeBenchmarkOptions<V extends string> = {
    chromePath: string;
    // Added to every Chrome launch, for example --host-resolver-rules.
    chromeFlags: string[];
    // The variant every other one is compared against.
    controlVariant: V;
    variants: RuntimeVariantTarget<V>[];
    pages: RuntimePage[];
    settings: RuntimeSettings;
    // Makes the load order and the bootstrap reproducible.
    seed: string;
    log: (message: string) => void;
    signal: AbortSignal | undefined;
};

const mapMetrics = <T>(getValue: (metric: RuntimeMetric) => T): Record<RuntimeMetric, T> => {
    return {
        fcpMs: getValue('fcpMs'),
        lcpMs: getValue('lcpMs'),
        scriptMs: getValue('scriptMs'),
        blockingBeforeLcpMs: getValue('blockingBeforeLcpMs'),
        jsTransferBytes: getValue('jsTransferBytes'),
        jsDecodedBytes: getValue('jsDecodedBytes'),
    };
};

// Every repetition runs each variant once per page, cache state and CPU rate, in a
// new random order, so drift during the run hits every variant and condition alike.
export const planLoads = <V extends string>({
    pages,
    random,
    settings,
    variants,
}: {
    pages: RuntimePage[];
    random: Random;
    settings: RuntimeSettings;
    variants: V[];
}): PlannedLoad<V>[] => {
    const plan: PlannedLoad<V>[] = [];
    for (let repetition = 0; repetition < settings.repetitions; repetition++) {
        const loads: PlannedLoad<V>[] = [];
        for (const cpuThrottling of settings.cpuThrottlingRates) {
            for (const page of pages) {
                for (const cache of RUNTIME_CACHE_STATES) {
                    for (const variant of variants) {
                        loads.push({ repetition, variant, page, cache, cpuThrottling });
                    }
                }
            }
        }
        const shuffled = shuffle(loads, random);
        plan.push(...shuffled);
    }
    return plan;
};

const getMetricValues = <V extends string>(
    loads: RuntimeLoad<V>[],
    metric: RuntimeMetric,
): number[] => {
    const values: number[] = [];
    for (const load of loads) {
        const value = load.metrics[metric];
        if (load.ok && value !== null) {
            values.push(value);
        }
    }
    return values;
};

export const summarizeLoads = <V extends string>({
    controlVariant,
    loads,
    pages,
    random,
    settings,
    variants,
}: {
    controlVariant: V;
    loads: RuntimeLoad<V>[];
    pages: RuntimePage[];
    random: Random;
    settings: RuntimeSettings;
    variants: V[];
}): RuntimeCondition<V>[] => {
    const conditions: RuntimeCondition<V>[] = [];
    for (const page of pages) {
        for (const cpuThrottling of settings.cpuThrottlingRates) {
            for (const cache of RUNTIME_CACHE_STATES) {
                const conditionLoads = loads.filter(
                    (load) =>
                        load.page === page.id &&
                        load.cache === cache &&
                        load.cpuThrottling === cpuThrottling,
                );
                const getVariantLoads = (variant: V): RuntimeLoad<V>[] =>
                    conditionLoads.filter((load) => load.variant === variant);
                const controlLoads = getVariantLoads(controlVariant);

                const summaries = variants.map((variant) => {
                    const variantLoads = getVariantLoads(variant);
                    const okLoads = variantLoads.filter((load) => load.ok).length;
                    return {
                        variant,
                        loads: okLoads,
                        failedLoads: variantLoads.length - okLoads,
                        metrics: mapMetrics((metric) => {
                            const values = getMetricValues(variantLoads, metric);
                            return summarizeMetric(values);
                        }),
                    };
                });
                const comparedVariants = variants.filter((variant) => variant !== controlVariant);
                const comparisons = comparedVariants.map((variant) => {
                    const variantLoads = getVariantLoads(variant);
                    return {
                        variant,
                        metrics: mapMetrics((metric) => {
                            const control = getMetricValues(controlLoads, metric);
                            const instrumented = getMetricValues(variantLoads, metric);
                            return compareMedians({
                                control,
                                instrumented,
                                random,
                                resamples: settings.bootstrapResamples,
                            });
                        }),
                    };
                });

                conditions.push({
                    page: page.id,
                    cache,
                    cpuThrottling,
                    variants: summaries,
                    comparisons,
                });
            }
        }
    }
    return conditions;
};

export type InsufficientVariant<V extends string> = {
    variant: V;
    condition: RuntimeCondition<V>;
    loads: number;
    failedLoads: number;
    message: string;
};

const describeInsufficient = <V extends string>(
    variant: V,
    { cache, cpuThrottling, page }: RuntimeCondition<V>,
    loads: number,
    failedLoads: number,
): string => {
    const condition = `${cache} cache, CPU ${cpuThrottling}x`;
    if (loads < MIN_SAMPLES_FOR_INTERVAL) {
        return `${variant} loaded ${page} only ${loads} times without errors (${condition}).`;
    }
    const total = loads + failedLoads;
    const allowed = Math.round(MAX_FAILED_LOAD_SHARE * 100);
    return `${variant} failed ${failedLoads} of ${total} loads of ${page} (${condition}), more than ${allowed}%.`;
};

// The first variant, control first, whose loads in a condition are too few for a
// confidence interval, or failed too often to trust.
export const findInsufficientVariant = <V extends string>(
    conditions: RuntimeCondition<V>[],
    controlVariant: V,
): InsufficientVariant<V> | undefined => {
    const summaries = conditions.flatMap((condition) =>
        condition.variants.map((summary) => ({ condition, summary })),
    );
    const ordered = [
        ...summaries.filter(({ summary }) => summary.variant === controlVariant),
        ...summaries.filter(({ summary }) => summary.variant !== controlVariant),
    ];
    const insufficient = ordered.find(({ summary }) => {
        const total = summary.loads + summary.failedLoads;
        const failedShare = total === 0 ? 0 : summary.failedLoads / total;
        return summary.loads < MIN_SAMPLES_FOR_INTERVAL || failedShare > MAX_FAILED_LOAD_SHARE;
    });
    if (!insufficient) {
        return undefined;
    }
    const { condition, summary } = insufficient;
    return {
        variant: summary.variant,
        condition,
        loads: summary.loads,
        failedLoads: summary.failedLoads,
        message: describeInsufficient(
            summary.variant,
            condition,
            summary.loads,
            summary.failedLoads,
        ),
    };
};

const getErrorMessage = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error);
};

const formatMilliseconds = (value: number | null): string => {
    return value === null ? 'n/a' : `${Math.round(value)} ms`;
};

const formatLoad = <V extends string>(load: RuntimeLoad<V>): string => {
    const condition = `${load.variant} ${load.page} ${load.cache} cpu ${load.cpuThrottling}x`;
    if (!load.ok) {
        return `${condition}: failed: ${load.error ?? 'unknown error'}`;
    }
    const fcp = formatMilliseconds(load.metrics.fcpMs);
    const lcp = formatMilliseconds(load.metrics.lcpMs);
    return `${condition}: FCP ${fcp}, LCP ${lcp}`;
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
    if (signal?.aborted) {
        throw new RuntimeAbortedError('The runtime benchmark was stopped.');
    }
};

const toLoad = <V extends string>(planned: PlannedLoad<V>, result: LoadResult): RuntimeLoad<V> => {
    return {
        repetition: planned.repetition,
        variant: planned.variant,
        page: planned.page.id,
        cache: planned.cache,
        cpuThrottling: planned.cpuThrottling,
        ok: result.error === null,
        error: result.error,
        metrics: result.metrics,
        jsRequests: result.jsRequests,
        pageErrors: result.pageErrors,
        failedRequests: result.failedRequests,
    };
};

const getFailedResult = (error: unknown): LoadResult => {
    return {
        error: getErrorMessage(error),
        metrics: {
            fcpMs: null,
            lcpMs: null,
            scriptMs: null,
            blockingBeforeLcpMs: null,
            jsTransferBytes: null,
            jsDecodedBytes: null,
        },
        jsRequests: 0,
        pageErrors: 0,
        failedRequests: 0,
    };
};

// Serves or points at each variant, starts two Chromes, checks that every variant
// loads, then measures the planned loads. The cold browser clears its caches before
// each load, and the warm one never does, so cold and warm loads can interleave.
export const runRuntimeBenchmark = async <V extends string>(
    options: RuntimeBenchmarkOptions<V>,
): Promise<RuntimeBenchmarkResult<V>> => {
    const { chromeFlags, chromePath, controlVariant, log, pages, settings, signal } = options;
    const startedAt = Date.now();
    const servers: StaticServer[] = [];
    const browsers: Chrome[] = [];
    const variantIds = options.variants.map((variant) => variant.id);
    let benchmarkResult: RuntimeBenchmarkResult<V>;

    try {
        const origins = new Map<V, string>();
        for (const variant of options.variants) {
            if ('root' in variant) {
                const server = await startStaticServer({
                    immutablePaths: variant.immutablePaths,
                    root: variant.root,
                });
                servers.push(server);
                origins.set(variant.id, server.origin);
            } else {
                origins.set(variant.id, variant.origin);
            }
        }
        const getOrigin = (variant: V): string => origins.get(variant) ?? '';
        const getCookies = (variant: V) =>
            options.variants.find((target) => target.id === variant)?.cookies ?? [];

        const coldBrowser = await launchChrome({ chromePath, flags: chromeFlags });
        browsers.push(coldBrowser);
        const warmBrowser = await launchChrome({ chromePath, flags: chromeFlags });
        browsers.push(warmBrowser);
        log(`Started ${coldBrowser.version}.`);

        // Control goes first, so a variant that fails after it is the suspect.
        const primingOrder = [
            controlVariant,
            ...variantIds.filter((variant) => variant !== controlVariant),
        ];
        for (const variant of primingOrder) {
            for (const page of pages) {
                throwIfAborted(signal);
                const visit = {
                    cookies: getCookies(variant),
                    maxWaitMs: settings.maxWaitMs,
                    origin: getOrigin(variant),
                    page,
                    signal,
                };
                try {
                    for (let visitIndex = 0; visitIndex < WARM_PRIMING_VISITS; visitIndex++) {
                        await visitPage({ ...visit, chrome: warmBrowser });
                    }
                    for (let visitIndex = 0; visitIndex < COLD_PRIMING_VISITS; visitIndex++) {
                        await visitPage({ ...visit, chrome: coldBrowser });
                    }
                } catch (error) {
                    throwIfAborted(signal);
                    // Chrome itself failing says nothing about the variant.
                    if (error instanceof ChromeConnectionError) {
                        throw error;
                    }
                    const message = getErrorMessage(error);
                    throw new RuntimeVariantError(
                        `${variant} didn't load ${page.id} in Chrome: ${message}`,
                        variant,
                    );
                }
            }
        }

        const orderRandom = createRandom(`${options.seed}:order`);
        const plan = planLoads({ pages, random: orderRandom, settings, variants: variantIds });
        const loads: RuntimeLoad<V>[] = [];
        for (const [index, planned] of plan.entries()) {
            throwIfAborted(signal);
            let result: LoadResult;
            try {
                result = await measureLoad({
                    cache: planned.cache,
                    chrome: planned.cache === 'cold' ? coldBrowser : warmBrowser,
                    cookies: getCookies(planned.variant),
                    cpuThrottling: planned.cpuThrottling,
                    lcpSettleMs: settings.lcpSettleMs,
                    maxWaitMs: settings.maxWaitMs,
                    network: settings.network,
                    origin: getOrigin(planned.variant),
                    page: planned.page,
                    signal,
                });
            } catch (error) {
                throwIfAborted(signal);
                // A broken Chrome would fail every load that follows, in every variant.
                if (error instanceof ChromeConnectionError) {
                    throw error;
                }
                result = getFailedResult(error);
            }
            const load = toLoad(planned, result);
            loads.push(load);
            const description = formatLoad(load);
            log(`Load ${index + 1}/${plan.length}: ${description}`);
        }
        const statisticsRandom = createRandom(`${options.seed}:bootstrap`);
        const conditions = summarizeLoads({
            controlVariant,
            loads,
            pages,
            random: statisticsRandom,
            settings,
            variants: variantIds,
        });
        benchmarkResult = {
            browser: {
                version: coldBrowser.version,
            },
            durationMs: Date.now() - startedAt,
            pages: pages.map(({ id, path }) => ({ id, path })),
            conditions,
            loads,
        };
    } finally {
        // A failed close mustn't hide why the benchmark stopped.
        const closers = [...browsers, ...servers];
        for (const closer of closers) {
            try {
                await closer.close();
            } catch (error) {
                const message = getErrorMessage(error);
                log(`Couldn't stop a browser or server: ${message}`);
            }
        }
    }
    // A stop during the last load, or while Chrome shuts down, mustn't produce a
    // result.
    throwIfAborted(signal);
    return benchmarkResult;
};
