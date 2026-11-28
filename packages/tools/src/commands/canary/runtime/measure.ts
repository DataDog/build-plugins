// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';

import type { Chrome, ChromePage } from './chrome.ts';
import { ChromeConnectionError, getNumber, getString, isRecord } from './chrome.ts';
import type {
    RuntimeCacheState,
    RuntimeCookie,
    RuntimeLoadMetrics,
    RuntimeNetworkThrottling,
    RuntimePage,
} from './types.ts';

const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const POLL_INTERVAL_MS = 100;
const SETTLE_POLL_INTERVAL_MS = 250;
// A priming load waits this long without requests before it ends.
const NETWORK_IDLE_MS = 500;
// How long a command may still take once a load's time is up. A page that doesn't
// answer by then, for example because a script loops, fails the load.
const COMMAND_GRACE_MS = 5_000;
const BITS_PER_MEGABIT = 1_000_000;
const BITS_PER_BYTE = 8;

export type LoadResult = {
    error: string | null;
    metrics: RuntimeLoadMetrics;
    jsRequests: number;
    pageErrors: number;
    failedRequests: number;
};

// The only script added to pages. Service workers would serve later loads from
// their own cache, and could cache variants differently, for example when an
// instrumented chunk outgrows a precache size limit. Without them, the HTTP cache
// alone decides what a load fetches. Registering fails like it does in browsers
// without service workers.
const BLOCK_SERVICE_WORKERS = `
    if (navigator.serviceWorker) {
        navigator.serviceWorker.register = () =>
            Promise.reject(new DOMException('Service workers are blocked.', 'SecurityError'));
    }
`;

// Reads buffered entries synchronously: observe() with `buffered` queues them, and
// takeRecords() returns them.
const READ_ENTRIES = `
    const readEntries = (type) => {
        if (!PerformanceObserver.supportedEntryTypes.includes(type)) {
            return null;
        }
        const observer = new PerformanceObserver(() => {});
        observer.observe({ type, buffered: true });
        const entries = observer.takeRecords();
        observer.disconnect();
        return entries;
    };
`;

const SETTLE_EXPRESSION = `(() => {
    ${READ_ENTRIES}
    const entries = readEntries('largest-contentful-paint') ?? [];
    const last = entries[entries.length - 1];
    return { now: performance.now(), lastLcpMs: last ? last.startTime : null };
})()`;

// Blocking time adds up the whole blocking duration of every Long Animation Frame
// that starts before LCP, so a frame that LCP falls into counts in full.
const COLLECT_EXPRESSION = `(() => {
    ${READ_ENTRIES}
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const lcpEntries = readEntries('largest-contentful-paint') ?? [];
    const lcp = lcpEntries[lcpEntries.length - 1];
    const frames = readEntries('long-animation-frame');
    const blockingBeforeLcpMs =
        lcp && frames
            ? frames
                  .filter((frame) => frame.startTime < lcp.startTime)
                  .reduce((total, frame) => total + frame.blockingDuration, 0)
            : null;
    return {
        fcpMs: fcp ? fcp.startTime : null,
        lcpMs: lcp ? lcp.startTime : null,
        blockingBeforeLcpMs,
        visibility: document.visibilityState,
    };
})()`;

const getVisibleExpression = (selector: string): string => {
    const selectorLiteral = JSON.stringify(selector);
    return `(() => {
        const element = document.querySelector(${selectorLiteral});
        if (!element) {
            return false;
        }
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden';
    })()`;
};

const getErrorMessage = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error);
};

const getNullableNumber = (value: unknown, key: string): number | null => {
    return getNumber(value, key) ?? null;
};

export const getPageUrl = (origin: string, page: RuntimePage): string => {
    const url = new URL(page.path, origin);
    return url.toString();
};

const getOrigin = (url: string): string | undefined => {
    try {
        return new URL(url).origin;
    } catch {
        return undefined;
    }
};

// A monotonic clock, so a load's time limit doesn't move with the system clock.
const now = (): number => performance.now();

const getRemainingMs = (deadline: number): number => {
    return Math.max(0, deadline - now());
};

type Limits = {
    // On the now() clock.
    deadline: number;
    signal: AbortSignal | undefined;
};

// Waits for promise, but no longer than COMMAND_GRACE_MS past the deadline, and not
// past an abort.
const withinLimits = <T>(promise: Promise<T>, { deadline, signal }: Limits, what: string) => {
    signal?.throwIfAborted();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const limit = new Promise<never>((_resolve, reject) => {
        const timeoutMs = getRemainingMs(deadline) + COMMAND_GRACE_MS;
        timeout = setTimeout(() => {
            reject(new Error(`${what} got no answer within the load's time limit.`));
        }, timeoutMs);
        if (signal) {
            onAbort = () => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
    return Promise.race([promise, limit]).finally(() => {
        clearTimeout(timeout);
        if (signal && onAbort) {
            signal.removeEventListener('abort', onAbort);
        }
    });
};

const evaluate = async (page: ChromePage, expression: string, limits: Limits) => {
    const request = page.send('Runtime.evaluate', { expression, returnByValue: true });
    const response = await withinLimits(request, limits, 'Runtime.evaluate');
    const exception = isRecord(response) ? response.exceptionDetails : undefined;
    if (exception !== undefined) {
        const text = getString(exception, 'text') ?? 'Uncaught exception';
        throw new Error(`Evaluating in the page failed: ${text}`);
    }
    const result = isRecord(response) ? response.result : undefined;
    return isRecord(result) ? result.value : undefined;
};

const navigate = async (page: ChromePage, url: string, limits: Limits): Promise<void> => {
    const loaded = page.waitFor('Page.loadEventFired', getRemainingMs(limits.deadline));
    // Navigation errors are reported below; don't let this one go unhandled first.
    // Closing the page cancels the wait.
    loaded.catch(() => undefined);
    const request = page.send('Page.navigate', { url });
    const navigation = await withinLimits(request, limits, 'Page.navigate');
    const errorText = getString(navigation, 'errorText');
    if (errorText) {
        throw new Error(`Loading ${url} failed: ${errorText}`);
    }
    await withinLimits(loaded, limits, 'The load event');
};

const waitForVisible = async (page: ChromePage, selector: string, limits: Limits) => {
    const expression = getVisibleExpression(selector);
    for (;;) {
        const visible = await evaluate(page, expression, limits);
        if (visible === true) {
            return;
        }
        if (now() >= limits.deadline) {
            throw new Error(`${selector} wasn't visible in time.`);
        }
        await wait(POLL_INTERVAL_MS, undefined, { signal: limits.signal });
    }
};

// Waits until no new LCP candidate has appeared for lcpSettleMs, or until the
// load's time is up.
const waitForLcpToSettle = async (page: ChromePage, lcpSettleMs: number, limits: Limits) => {
    for (;;) {
        if (now() >= limits.deadline) {
            return;
        }
        const state = await evaluate(page, SETTLE_EXPRESSION, limits);
        const pageNow = getNumber(state, 'now') ?? 0;
        const lastLcpMs = getNumber(state, 'lastLcpMs');
        if (lastLcpMs !== undefined && pageNow - lastLcpMs >= lcpSettleMs) {
            return;
        }
        await wait(SETTLE_POLL_INTERVAL_MS, undefined, { signal: limits.signal });
    }
};

const isScript = (type: string | undefined, url: string): boolean => {
    return type === 'Script' || /\.m?js($|\?)/.test(url);
};

type TrackedRequest = {
    decodedBytes: number;
    failed: boolean;
    finished: boolean;
    transferBytes: number;
    type: string | undefined;
    url: string;
};

type NetworkTracker = {
    getInFlight: () => number;
    getLastActivity: () => number;
    summarize: () => {
        failedRequests: number;
        jsDecodedBytes: number;
        jsRequests: number;
        jsTransferBytes: number;
    };
};

// Follows a load's requests through CDP's network events. Only requests to the
// page's own origin count, so scripts served from another host aren't measured.
// Scripts count over the whole load: bytes "before LCP" would give the slower
// variant a longer window. Exported for tests.
export const trackNetwork = (page: Pick<ChromePage, 'on'>, pageOrigin: string): NetworkTracker => {
    const requests = new Map<string, TrackedRequest>();
    let inFlight = 0;
    let lastActivity = now();
    const getRequest = (params: unknown): TrackedRequest => {
        lastActivity = now();
        const requestId = getString(params, 'requestId') ?? '';
        let request = requests.get(requestId);
        if (!request) {
            request = {
                decodedBytes: 0,
                failed: false,
                finished: false,
                transferBytes: 0,
                type: undefined,
                url: '',
            };
            requests.set(requestId, request);
        }
        return request;
    };
    const finish = (request: TrackedRequest): void => {
        if (!request.finished) {
            request.finished = true;
            inFlight = Math.max(0, inFlight - 1);
        }
    };

    page.on('Network.requestWillBeSent', (params) => {
        const request = getRequest(params);
        const details = isRecord(params) ? params.request : undefined;
        // Redirects reuse the request ID.
        if (request.url === '') {
            inFlight += 1;
        }
        request.url = getString(details, 'url') ?? request.url;
        request.type = getString(params, 'type') ?? request.type;
    });
    page.on('Network.responseReceived', (params) => {
        const request = getRequest(params);
        const response = isRecord(params) ? params.response : undefined;
        request.type = getString(params, 'type') ?? request.type;
        const status = getNumber(response, 'status') ?? 0;
        if (status >= 400) {
            request.failed = true;
        }
    });
    page.on('Network.dataReceived', (params) => {
        const request = getRequest(params);
        request.decodedBytes += getNumber(params, 'dataLength') ?? 0;
    });
    page.on('Network.loadingFinished', (params) => {
        const request = getRequest(params);
        request.transferBytes = getNumber(params, 'encodedDataLength') ?? 0;
        finish(request);
    });
    page.on('Network.loadingFailed', (params) => {
        const request = getRequest(params);
        request.failed = true;
        finish(request);
    });

    return {
        getInFlight: () => inFlight,
        getLastActivity: () => lastActivity,
        summarize: () => {
            const ownRequests = Array.from(requests.values()).filter(
                (request) => getOrigin(request.url) === pageOrigin,
            );
            const scripts = ownRequests.filter(
                (request) =>
                    request.finished && !request.failed && isScript(request.type, request.url),
            );
            return {
                failedRequests: ownRequests.filter((request) => request.failed).length,
                jsDecodedBytes: scripts.reduce((total, request) => total + request.decodedBytes, 0),
                jsRequests: scripts.length,
                jsTransferBytes: scripts.reduce(
                    (total, request) => total + request.transferBytes,
                    0,
                ),
            };
        },
    };
};

const waitForNetworkIdle = async (network: NetworkTracker, limits: Limits): Promise<void> => {
    while (now() < limits.deadline) {
        const quietMs = now() - network.getLastActivity();
        if (network.getInFlight() === 0 && quietMs >= NETWORK_IDLE_MS) {
            return;
        }
        await wait(POLL_INTERVAL_MS, undefined, { signal: limits.signal });
    }
};

const getNetworkConditions = (network: RuntimeNetworkThrottling) => {
    return {
        offline: false,
        latency: network.latencyMs,
        downloadThroughput: (network.downloadMbps * BITS_PER_MEGABIT) / BITS_PER_BYTE,
        uploadThroughput: (network.uploadMbps * BITS_PER_MEGABIT) / BITS_PER_BYTE,
    };
};

type PreparedPage = {
    page: ChromePage;
    network: NetworkTracker;
    getPageErrors: () => string[];
};

const preparePage = async ({
    chrome,
    clearCache,
    cookies,
    pageOrigin,
}: {
    chrome: Chrome;
    clearCache: boolean;
    cookies: RuntimeCookie[];
    pageOrigin: string;
}): Promise<PreparedPage> => {
    const page = await chrome.newPage();
    try {
        const pageErrors: string[] = [];
        page.on('Runtime.exceptionThrown', (params) => {
            const details = isRecord(params) ? params.exceptionDetails : undefined;
            const exception = isRecord(details) ? details.exception : undefined;
            const description = getString(exception, 'description') ?? getString(details, 'text');
            pageErrors.push(description ?? 'Uncaught exception');
        });
        const network = trackNetwork(page, pageOrigin);
        await page.send('Page.enable');
        await page.send('Page.addScriptToEvaluateOnNewDocument', {
            source: BLOCK_SERVICE_WORKERS,
        });
        await page.send('Runtime.enable');
        await page.send('Network.enable');
        await page.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
        if (clearCache) {
            // Clears the HTTP cache and V8's code cache of the whole profile, which
            // only cold loads use.
            await page.send('Network.clearBrowserCache');
            await page.send('Storage.clearDataForOrigin', {
                origin: pageOrigin,
                storageTypes: 'all',
            });
        }
        if (cookies.length > 0) {
            await page.send('Network.setCookies', { cookies });
        }
        await page.send('Page.bringToFront');
        return { page, network, getPageErrors: () => pageErrors };
    } catch (error) {
        try {
            await page.close();
        } catch {
            // The error that stopped the preparation matters more.
        }
        throw error;
    }
};

// Errors that end the whole run instead of one load.
const isFatal = (error: unknown, signal: AbortSignal | undefined): boolean => {
    return error instanceof ChromeConnectionError || signal?.aborted === true;
};

// Loads a page without measuring it, to fill the caches or to check that the build
// works at all.
export const visitPage = async ({
    chrome,
    cookies,
    maxWaitMs,
    origin,
    page: runtimePage,
    signal,
}: {
    chrome: Chrome;
    cookies: RuntimeCookie[];
    maxWaitMs: number;
    origin: string;
    page: RuntimePage;
    signal: AbortSignal | undefined;
}): Promise<void> => {
    const url = getPageUrl(origin, runtimePage);
    const pageOrigin = new URL(url).origin;
    const { page, network, getPageErrors } = await preparePage({
        chrome,
        clearCache: false,
        cookies,
        pageOrigin,
    });
    try {
        const limits = { deadline: now() + maxWaitMs, signal };
        await navigate(page, url, limits);
        await waitForVisible(page, runtimePage.readySelector, limits);
        // Lets lazy chunks load and V8 write its code cache.
        await waitForNetworkIdle(network, limits);
    } catch (error) {
        if (isFatal(error, signal)) {
            throw error;
        }
        const message = getErrorMessage(error);
        const pageErrors = getPageErrors();
        const details = pageErrors.length > 0 ? ` Page errors: ${pageErrors.join('; ')}` : '';
        throw new Error(`${message}${details}`);
    } finally {
        await page.close();
    }
};

// Measures one load. A load that fails returns its error; Chrome failures and
// aborts throw.
export const measureLoad = async ({
    cache,
    chrome,
    cookies,
    cpuThrottling,
    lcpSettleMs,
    maxWaitMs,
    network: networkThrottling,
    origin,
    page: runtimePage,
    signal,
}: {
    cache: RuntimeCacheState;
    chrome: Chrome;
    cookies: RuntimeCookie[];
    cpuThrottling: number;
    lcpSettleMs: number;
    maxWaitMs: number;
    network: RuntimeNetworkThrottling | null;
    origin: string;
    page: RuntimePage;
    signal: AbortSignal | undefined;
}): Promise<LoadResult> => {
    const url = getPageUrl(origin, runtimePage);
    const pageOrigin = new URL(url).origin;
    const { page, network, getPageErrors } = await preparePage({
        chrome,
        clearCache: cache === 'cold',
        cookies,
        pageOrigin,
    });
    const metrics: RuntimeLoadMetrics = {
        fcpMs: null,
        lcpMs: null,
        scriptMs: null,
        blockingBeforeLcpMs: null,
        jsTransferBytes: null,
        jsDecodedBytes: null,
    };

    try {
        await page.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottling });
        if (networkThrottling) {
            const conditions = getNetworkConditions(networkThrottling);
            await page.send('Network.emulateNetworkConditions', conditions);
        }
        await page.send('Performance.enable', { timeDomain: 'timeTicks' });

        const limits = { deadline: now() + maxWaitMs, signal };
        let error: string | null = null;
        try {
            await navigate(page, url, limits);
            await waitForVisible(page, runtimePage.readySelector, limits);
            await waitForLcpToSettle(page, lcpSettleMs, limits);
            const inPage = await evaluate(page, COLLECT_EXPRESSION, limits);
            metrics.fcpMs = getNullableNumber(inPage, 'fcpMs');
            metrics.lcpMs = getNullableNumber(inPage, 'lcpMs');
            metrics.blockingBeforeLcpMs = getNullableNumber(inPage, 'blockingBeforeLcpMs');
            const visibility = getString(inPage, 'visibility');
            if (visibility !== 'visible') {
                error = `The page was ${visibility ?? 'not visible'} during the load.`;
            } else if (metrics.fcpMs === null || metrics.lcpMs === null) {
                error = 'Chrome reported no FCP or LCP.';
            }
        } catch (loadError) {
            if (isFatal(loadError, signal)) {
                throw loadError;
            }
            error = getErrorMessage(loadError);
        }

        // A failed load's metrics aren't used, and its page may not answer.
        if (error === null) {
            const request = page.send('Performance.getMetrics');
            const performanceMetrics = await withinLimits(
                request,
                limits,
                'Performance.getMetrics',
            );
            const metricList = isRecord(performanceMetrics)
                ? performanceMetrics.metrics
                : undefined;
            const entries: unknown[] = Array.isArray(metricList) ? metricList : [];
            const scriptDuration = entries.find(
                (entry) => getString(entry, 'name') === 'ScriptDuration',
            );
            // Reported in seconds, for the whole load.
            const scriptSeconds = getNumber(scriptDuration, 'value');
            metrics.scriptMs = scriptSeconds === undefined ? null : scriptSeconds * 1_000;
        }
        const networkSummary = network.summarize();
        metrics.jsTransferBytes = networkSummary.jsTransferBytes;
        metrics.jsDecodedBytes = networkSummary.jsDecodedBytes;

        return {
            error,
            metrics,
            jsRequests: networkSummary.jsRequests,
            pageErrors: getPageErrors().length,
            failedRequests: networkSummary.failedRequests,
        };
    } finally {
        await page.close();
    }
};
