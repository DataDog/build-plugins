// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import type { IncomingMessage, ServerResponse } from 'http';

import type { CspServerConfig } from './dev-server-csp';
import { createProxyMatcher, getProxyContexts } from './dev-server-csp';
import { quoteForTerminal } from './dev-server-request-guard';

// The plugin's own POST endpoints, which only run on the dev server.
export const DEV_SERVER_ROUTE_PREFIX = '/__dd/';
// Caps the warned set so paths that carry IDs can't grow it without bound.
export const MAX_WARNED_ORIGIN_GAPS = 32;
export const ORIGIN_GAP_WARNINGS_CAPPED_MESSAGE =
    "Further warnings like this are only logged with the Datadog plugin's `logLevel: 'debug'`.";

const FRAME_DESTINATIONS = new Set(['iframe', 'frame']);
// A preflight comes from another origin, so the app never sends one to its own.
const EXEMPT_METHODS = new Set(['GET', 'OPTIONS']);
// The app's own requests are same-origin; tools such as curl send no Sec-Fetch-Site.
const OWN_ORIGIN_SITES = new Set(['', 'same-origin']);

type OriginGap = { key: string; message: string };

export const getSameOriginFrameWarning = (path: string): string =>
    `${quoteForTerminal(path)} was loaded in a frame by a page on its own origin. An uploaded app can't frame its own pages, so this works only on the dev server.`;

export const getNonGetWarning = (method: string, path: string): string =>
    `${method} ${quoteForTerminal(path)} works only on the dev server. An uploaded app's origin answers only GET requests for the app's built files.`;

export const formatProxyWarning = (contexts: string[]): string =>
    `server.proxy paths (${contexts.join(', ')}) work only on the dev server. An uploaded app's origin serves only the app's built files, so call those services from a backend function, or by their full https: URL if they accept cross-origin requests.`;

export const getProxyWarning = (config: CspServerConfig): string | undefined => {
    const contexts = getProxyContexts(config.server.proxy);
    return contexts.length > 0 ? formatProxyWarning(contexts) : undefined;
};

const getOriginGaps = (req: IncomingMessage, path: string): OriginGap[] => {
    const method = req.method ?? 'GET';
    const destination = String(req.headers['sec-fetch-dest'] ?? '');
    const site = String(req.headers['sec-fetch-site'] ?? '');
    const gaps: OriginGap[] = [];
    if (FRAME_DESTINATIONS.has(destination) && site === 'same-origin') {
        gaps.push({ key: `frame ${path}`, message: getSameOriginFrameWarning(path) });
    }
    const isOwnRequest = OWN_ORIGIN_SITES.has(site) && !path.startsWith(DEV_SERVER_ROUTE_PREFIX);
    if (isOwnRequest && !EXEMPT_METHODS.has(method)) {
        gaps.push({ key: `method ${path}`, message: getNonGetWarning(method, path) });
    }
    return gaps;
};

/**
 * Warns about requests that work on the dev server but fail once the app is uploaded, which the
 * app CSP allows and so never reports. Requests pass through unchanged.
 */
export const createOriginGapMiddleware = (config: CspServerConfig, log: Logger) => {
    const isProxiedUrl = createProxyMatcher(config.server.proxy);
    const warned = new Set<string>();
    let hasLoggedWarningCap = false;
    const logGap = ({ key, message }: OriginGap): void => {
        if (warned.has(key)) {
            return;
        }
        if (warned.size < MAX_WARNED_ORIGIN_GAPS) {
            warned.add(key);
            log.warn(message);
            return;
        }
        if (!hasLoggedWarningCap) {
            hasLoggedWarningCap = true;
            log.warn(`${message} ${ORIGIN_GAP_WARNINGS_CAPPED_MESSAGE}`);
            return;
        }
        log.debug(message);
    };

    return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
        const url = req.url ?? '';
        // server.proxy paths get one warning at startup instead.
        if (!isProxiedUrl(url)) {
            const [path] = url.split('?');
            const gaps = getOriginGaps(req, path);
            gaps.forEach(logGap);
        }
        next();
    };
};
