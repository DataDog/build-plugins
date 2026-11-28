// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { setTimeout as wait } from 'node:timers/promises';

import type { Chrome, ChromePage } from './chrome.ts';
import { getNumber, getString, isRecord } from './chrome.ts';
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

// Blocking time adds up the Long Animation Frames that start before LCP.
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

const evaluate = async (page: ChromePage, expression: string): Promise<unknown> => {
    const response = await page.send('Runtime.evaluate', { expression, returnByValue: true });
    const exception = isRecord(response) ? response.exceptionDetails : undefined;
    if (exception !== undefined) {
        const text = getString(exception, 'text') ?? 'Uncaught exception';
        throw new Error(`Evaluating in the page failed: ${text}`);
    }
    const result = isRecord(response) ? response.result : undefined;
    return isRecord(result) ? result.value : undefined;
};

const getRemainingMs = (deadline: number): number => {
    return Math.max(0, deadline - Date.now());
};

const navigate = async (page: ChromePage, url: string, deadline: number): Promise<void> => {
    const timeoutMs = getRemainingMs(deadline);
    const loaded = page.waitFor('Page.loadEventFired', timeoutMs);
    // Navigation errors are reported below; don't let this one go unhandled first.
    loaded.catch(() => undefined);
    const navigation = await page.send('Page.navigate', { url });
    const errorText = getString(navigation, 'errorText');
    if (errorText) {
        throw new Error(`Loading ${url} failed: ${errorText}`);
    }
    await loaded;
};

const waitForVisible = async (page: ChromePage, selector: string, deadline: number) => {
    const expression = getVisibleExpression(selector);
    for (;;) {
        const visible = await evaluate(page, expression);
        if (visible === true) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new Error(`${selector} wasn't visible in time.`);
        }
        await wait(POLL_INTERVAL_MS);
    }
};

// Waits until no new LCP candidate has appeared for lcpSettleMs, or until
// maxWaitMs have passed since navigation started.
const waitForLcpToSettle = async (
    page: ChromePage,
    { lcpSettleMs, maxWaitMs }: { lcpSettleMs: number; maxWaitMs: number },
): Promise<void> => {
    for (;;) {
        const state = await evaluate(page, SETTLE_EXPRESSION);
        const now = getNumber(state, 'now') ?? 0;
        const lastLcpMs = getNumber(state, 'lastLcpMs');
        if (now >= maxWaitMs) {
            return;
        }
        if (lastLcpMs !== undefined && now - lastLcpMs >= lcpSettleMs) {
            return;
        }
        await wait(SETTLE_POLL_INTERVAL_MS);
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

// Follows a load's requests through CDP's network events. Scripts count over the
// whole load: bytes "before LCP" would give the slower variant a longer window.
const trackNetwork = (page: ChromePage, origin: string): NetworkTracker => {
    const requests = new Map<string, TrackedRequest>();
    let inFlight = 0;
    let lastActivity = Date.now();
    const getRequest = (params: unknown): TrackedRequest => {
        lastActivity = Date.now();
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
            const ownRequests = Array.from(requests.values()).filter((request) =>
                request.url.startsWith(origin),
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

const waitForNetworkIdle = async (network: NetworkTracker, deadline: number): Promise<void> => {
    while (Date.now() < deadline) {
        const quietMs = Date.now() - network.getLastActivity();
        if (network.getInFlight() === 0 && quietMs >= NETWORK_IDLE_MS) {
            return;
        }
        await wait(POLL_INTERVAL_MS);
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
    origin,
}: {
    chrome: Chrome;
    clearCache: boolean;
    cookies: RuntimeCookie[];
    origin: string;
}): Promise<PreparedPage> => {
    const page = await chrome.newPage();
    const pageErrors: string[] = [];
    page.on('Runtime.exceptionThrown', (params) => {
        const details = isRecord(params) ? params.exceptionDetails : undefined;
        const exception = isRecord(details) ? details.exception : undefined;
        const description = getString(exception, 'description') ?? getString(details, 'text');
        pageErrors.push(description ?? 'Uncaught exception');
    });
    const network = trackNetwork(page, origin);
    await page.send('Page.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: BLOCK_SERVICE_WORKERS });
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    await page.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
    if (clearCache) {
        // Clears the HTTP cache and V8's code cache of the whole profile, which
        // only cold loads use.
        await page.send('Network.clearBrowserCache');
        await page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    }
    if (cookies.length > 0) {
        await page.send('Network.setCookies', { cookies });
    }
    await page.send('Page.bringToFront');
    return { page, network, getPageErrors: () => pageErrors };
};

// Loads a page without measuring it, to fill the caches or to check that the build
// works at all.
export const visitPage = async ({
    chrome,
    cookies,
    maxWaitMs,
    origin,
    page: runtimePage,
}: {
    chrome: Chrome;
    cookies: RuntimeCookie[];
    maxWaitMs: number;
    origin: string;
    page: RuntimePage;
}): Promise<void> => {
    const deadline = Date.now() + maxWaitMs;
    const { page, network, getPageErrors } = await preparePage({
        chrome,
        clearCache: false,
        cookies,
        origin,
    });
    try {
        const url = getPageUrl(origin, runtimePage);
        await navigate(page, url, deadline);
        await waitForVisible(page, runtimePage.readySelector, deadline);
        // Lets lazy chunks load and V8 write its code cache.
        await waitForNetworkIdle(network, deadline);
    } catch (error) {
        const message = getErrorMessage(error);
        const pageErrors = getPageErrors();
        const details = pageErrors.length > 0 ? ` Page errors: ${pageErrors.join('; ')}` : '';
        throw new Error(`${message}${details}`);
    } finally {
        await page.close();
    }
};

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
}): Promise<LoadResult> => {
    const { page, network, getPageErrors } = await preparePage({
        chrome,
        clearCache: cache === 'cold',
        cookies,
        origin,
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

        let error: string | null = null;
        try {
            const deadline = Date.now() + maxWaitMs;
            const url = getPageUrl(origin, runtimePage);
            await navigate(page, url, deadline);
            await waitForVisible(page, runtimePage.readySelector, deadline);
            await waitForLcpToSettle(page, { lcpSettleMs, maxWaitMs });
            const inPage = await evaluate(page, COLLECT_EXPRESSION);
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
            error = getErrorMessage(loadError);
        }

        const performanceMetrics = await page.send('Performance.getMetrics');
        const metricList = isRecord(performanceMetrics) ? performanceMetrics.metrics : undefined;
        const entries: unknown[] = Array.isArray(metricList) ? metricList : [];
        const scriptDuration = entries.find(
            (entry) => getString(entry, 'name') === 'ScriptDuration',
        );
        // Reported in seconds, for the whole load.
        const scriptSeconds = getNumber(scriptDuration, 'value');
        metrics.scriptMs = scriptSeconds === undefined ? null : scriptSeconds * 1_000;
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
