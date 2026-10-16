// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import type { Logger } from '@dd/core/types';

import type { AuthCredentials } from './auth';
import { createAuthenticatedRequest } from './auth';
import {
    DATATRANSFORMATION_BUNDLE_ID,
    FAILED_LOOKUP_RETRY_MS,
    getCacheKey,
    SCRIPT_ACTION_NAME,
    summarizeRequestError,
} from './backend-runtime';

export const DATATRANSFORMATION_MANIFEST_PATH = `/api/v2/workflow_actions/${DATATRANSFORMATION_BUNDLE_ID}`;
export const SCRIPT_LIMIT_TIMEOUT_MS = 3_000;

// The manifest keys each action's input schema by its TypeScript type name.
export const SCRIPT_INPUTS_DEF_NAME = `${SCRIPT_ACTION_NAME.charAt(0).toUpperCase()}${SCRIPT_ACTION_NAME.slice(1)}Inputs`;

// Kept on globalThis for the same reason as the backend runtime lookup: a dev server restart can
// load a fresh copy of this module.
export const SCRIPT_LIMIT_CACHE_KEY = Symbol.for('@datadog/vite-plugin/apps/script-limit');

export const MAX_SCRIPT_LIMIT_READS = 3;
export const SCRIPT_LIMIT_COOL_DOWN_MS = 15 * 60_000;

// Doubles after each failed read; the last read of a budget waits out the cool-down instead.
export function scriptLimitRetryDelayMs(failedReads: number): number {
    if (failedReads >= MAX_SCRIPT_LIMIT_READS) {
        return SCRIPT_LIMIT_COOL_DOWN_MS;
    }
    return FAILED_LOOKUP_RETRY_MS * 2 ** (failedReads - 1);
}

export const SCRIPT_LIMIT_WARNING =
    "Could not read the backend function script limit, so the dev server can't check the bundles it sends to Datadog's cloud against it.";

type CacheEntry = { limit: Promise<number | undefined>; expiresAt: number; failedReads?: number };

// Another copy of the plugin in the process may have stored a different shape under the same key.
function isCacheEntry(value: unknown): value is CacheEntry {
    return (
        typeof value === 'object' &&
        value !== null &&
        'limit' in value &&
        value.limit instanceof Promise &&
        'expiresAt' in value &&
        typeof value.expiresAt === 'number'
    );
}

function getScriptLimitCache(): Map<string, unknown> {
    const existing: unknown = Reflect.get(globalThis, SCRIPT_LIMIT_CACHE_KEY);
    if (existing instanceof Map) {
        return existing;
    }
    const cache = new Map<string, unknown>();
    Reflect.set(globalThis, SCRIPT_LIMIT_CACHE_KEY, cache);
    return cache;
}

// Test-only escape hatch: forgets every memoized lookup.
export function resetScriptLimitCache(): void {
    getScriptLimitCache().clear();
}

export function getProperty(value: unknown, key: string): unknown {
    return typeof value === 'object' && value !== null && key in value
        ? Reflect.get(value, key)
        : undefined;
}

function isScriptLimit(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

const MAX_LENGTH_PATH = [
    'data',
    'attributes',
    'types',
    '$defs',
    SCRIPT_INPUTS_DEF_NAME,
    'properties',
    'script',
    'maxLength',
];

async function lookUpScriptMaxLength(
    site: string,
    credentials: AuthCredentials,
    log: Logger,
): Promise<number | undefined> {
    try {
        const doAuthenticatedRequest = createAuthenticatedRequest(credentials);
        const signal = AbortSignal.timeout(SCRIPT_LIMIT_TIMEOUT_MS);
        const body = await doAuthenticatedRequest<unknown>({
            url: `https://api.${site}${DATATRANSFORMATION_MANIFEST_PATH}`,
            type: 'json',
            retries: 0,
            signal,
        });
        const maxLength = MAX_LENGTH_PATH.reduce(getProperty, body);
        if (!isScriptLimit(maxLength)) {
            log.debug('Backend function script limit not found in the action manifest.');
            return undefined;
        }
        log.debug(`Backend function script limit: ${maxLength}`);
        return maxLength;
    } catch (error) {
        const reason = summarizeRequestError(error);
        log.debug(`Backend function script limit read failed: ${reason}`);
        return undefined;
    }
}

/**
 * Reads jsFunctionWithActions's `script.maxLength` from the live action manifest, per site and
 * credentials. A read that finds it lasts the process; after one that doesn't, a later call reads
 * again once `scriptLimitRetryDelayMs` has passed, so at most `MAX_SCRIPT_LIMIT_READS` reads per
 * cool-down. Never rejects: resolves to undefined while the limit can't be read, even from another
 * plugin copy's broken cache entry.
 */
export async function resolveScriptMaxLength(
    site: string,
    credentials: AuthCredentials,
    log: Logger,
): Promise<number | undefined> {
    try {
        const limit: unknown = await cachedScriptMaxLength(site, credentials, log);
        return isScriptLimit(limit) ? limit : undefined;
    } catch {
        return undefined;
    }
}

function cachedScriptMaxLength(
    site: string,
    credentials: AuthCredentials,
    log: Logger,
): Promise<number | undefined> {
    const cache = getScriptLimitCache();
    const cacheKey = getCacheKey(site, credentials);
    const cached = cache.get(cacheKey);
    const previous = isCacheEntry(cached) ? cached : undefined;
    if (previous && previous.expiresAt > Date.now()) {
        return previous.limit;
    }

    // A budget starts over once its reads run out, or once it has sat expired for a cool-down.
    const cachedFailures = previous?.failedReads;
    const isRecent =
        previous !== undefined && previous.expiresAt + SCRIPT_LIMIT_COOL_DOWN_MS > Date.now();
    const isBudgetLeft =
        typeof cachedFailures === 'number' &&
        Number.isInteger(cachedFailures) &&
        cachedFailures >= 1 &&
        cachedFailures < MAX_SCRIPT_LIMIT_READS;
    const earlierFailures = isBudgetLeft && isRecent ? cachedFailures : 0;
    const lookup = lookUpScriptMaxLength(site, credentials, log);
    const entry: CacheEntry = {
        limit: lookup.then((limit) => {
            if (limit === undefined) {
                const failedReads = earlierFailures + 1;
                entry.failedReads = failedReads;
                entry.expiresAt = Date.now() + scriptLimitRetryDelayMs(failedReads);
                // After the expiry, so a logger that throws can't keep the failure cached for good.
                log.warn(SCRIPT_LIMIT_WARNING);
            }
            return limit;
        }),
        expiresAt: Number.POSITIVE_INFINITY,
    };
    cache.set(cacheKey, entry);
    return entry.limit;
}
