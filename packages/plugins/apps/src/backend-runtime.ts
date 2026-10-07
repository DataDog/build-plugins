// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import type { Logger } from '@dd/core/types';
import { createHash } from 'crypto';

import type { AuthCredentials } from './auth';
import { createAuthenticatedRequest, getAuthCredentials } from './auth';

export type BackendRuntime = 'v1' | 'v2';

export const TERRAPIN_BACKEND_FUNCTIONS_FLAG = 'app-builder-code-terrapin-backend-functions';
export const ACTIVE_FEATURE_FLAGS_PATH = '/api/ui/feature-flags/get-active-feature-flags';
export const BACKEND_RUNTIME_TIMEOUT_MS = 3_000;

export const RUNTIME_ACTION_NAMES: Record<BackendRuntime, string> = {
    v1: 'jsFunctionWithActions',
    v2: 'jsSandboxWithActions',
};

// Cloud execution submits jsFunctionWithActions queries whatever the org's runtime.
export const CLOUD_EXECUTION_RUNTIME: BackendRuntime = 'v1';

// The endpoint can rate-limit, so a successful lookup is reused for the life of the process; kept on
// globalThis because a dev server restart can load a fresh copy of this module.
export const RUNTIME_CACHE_KEY = Symbol.for('@datadog/vite-plugin/apps/backend-runtime');

// A failed lookup falls back to v1, which rejects valid v2 code, so it's retried after this long.
export const FAILED_LOOKUP_RETRY_MS = 60_000;

// doRequest appends the error body after the status line, which for a non-JSON reply can be a whole HTML page.
export const MAX_LOGGED_REASON_LENGTH = 200;

type CacheEntry = { runtime: Promise<BackendRuntime>; expiresAt: number };

// Another copy of the plugin in the process may have stored a different shape under the same key.
function isCacheEntry(value: unknown): value is CacheEntry {
    return (
        typeof value === 'object' &&
        value !== null &&
        'runtime' in value &&
        value.runtime instanceof Promise &&
        'expiresAt' in value &&
        typeof value.expiresAt === 'number'
    );
}

function getRuntimeCache(): Map<string, unknown> {
    const existing: unknown = Reflect.get(globalThis, RUNTIME_CACHE_KEY);
    if (existing instanceof Map) {
        return existing;
    }
    const cache = new Map<string, unknown>();
    Reflect.set(globalThis, RUNTIME_CACHE_KEY, cache);
    return cache;
}

// Test-only escape hatch: forgets every memoized lookup.
export function resetBackendRuntimeCache(): void {
    getRuntimeCache().clear();
}

function runtimeFromResponse(body: unknown): BackendRuntime {
    if (typeof body !== 'object' || body === null || !('user_status' in body)) {
        throw new Error('Unexpected response shape.');
    }
    if (body.user_status !== 'logged-in') {
        throw new Error('The credentials were not recognized as a logged-in user.');
    }
    if (!('active_feature_flags' in body) || !Array.isArray(body.active_feature_flags)) {
        throw new Error('Unexpected response shape.');
    }
    return body.active_feature_flags.includes(TERRAPIN_BACKEND_FUNCTIONS_FLAG) ? 'v2' : 'v1';
}

type LookupResult = { runtime: BackendRuntime; failed: boolean };

async function lookUpBackendRuntime(
    site: string,
    credentials: AuthCredentials | undefined,
    log: Logger,
): Promise<LookupResult> {
    if (!credentials) {
        log.debug('No Datadog credentials, so the v1 backend function runtime applies.');
        log.info(`Following the default v1 backend function runtime (${RUNTIME_ACTION_NAMES.v1}).`);
        return { runtime: 'v1', failed: false };
    }

    try {
        const doAuthenticatedRequest = createAuthenticatedRequest(credentials);
        const signal = AbortSignal.timeout(BACKEND_RUNTIME_TIMEOUT_MS);
        const body = await doAuthenticatedRequest<unknown>({
            url: `https://api.${site}${ACTIVE_FEATURE_FLAGS_PATH}`,
            type: 'json',
            retries: 0,
            signal,
        });
        const runtime = runtimeFromResponse(body);
        log.info(
            `Following the org's ${runtime} backend function runtime (${RUNTIME_ACTION_NAMES[runtime]}).`,
        );
        return { runtime, failed: false };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = message.split('\n').join('; ').slice(0, MAX_LOGGED_REASON_LENGTH);
        log.warn(
            `Could not read the org's backend function runtime, so v1 (${RUNTIME_ACTION_NAMES.v1}) applies and its checks run: ${reason}`,
        );
        return { runtime: 'v1', failed: true };
    }
}

// One entry per set of credentials, since the runtime is per org. Hashed so the cache never holds
// the secrets themselves.
export function getCacheKey(site: string, credentials: AuthCredentials | undefined): string {
    if (!credentials) {
        return `${site}:none`;
    }
    const serialized = JSON.stringify(credentials);
    const credentialsHash = createHash('sha256').update(serialized).digest('hex');
    return `${site}:${credentialsHash}`;
}

/**
 * Reads the internal experiment that app-builder-code uses to choose the runtime at upload time.
 * Never rejects: any failure, including missing credentials, resolves to 'v1'.
 */
export function resolveBackendRuntime(site: string, log: Logger): Promise<BackendRuntime> {
    const cache = getRuntimeCache();
    const credentials = getAuthCredentials();
    const cacheKey = getCacheKey(site, credentials);
    const cached = cache.get(cacheKey);
    if (isCacheEntry(cached) && cached.expiresAt > Date.now()) {
        return cached.runtime;
    }

    const lookup = lookUpBackendRuntime(site, credentials, log);
    const entry: CacheEntry = {
        runtime: lookup.then(({ runtime, failed }) => {
            if (failed) {
                entry.expiresAt = Date.now() + FAILED_LOOKUP_RETRY_MS;
            }
            return runtime;
        }),
        expiresAt: Number.POSITIVE_INFINITY,
    };
    cache.set(cacheKey, entry);
    return entry.runtime;
}

export type BackendRuntimeStatus = { runtime: BackendRuntime; isFallback: boolean };

/** Like resolveBackendRuntime, and also says whether v1 applies only because the lookup failed. */
export async function resolveBackendRuntimeStatus(
    site: string,
    log: Logger,
): Promise<BackendRuntimeStatus> {
    const credentials = getAuthCredentials();
    const cacheKey = getCacheKey(site, credentials);
    const pending = resolveBackendRuntime(site, log);
    const runtime = await pending;
    const entry = getRuntimeCache().get(cacheKey);
    // Only a failed lookup's entry expires; a replaced entry no longer describes this result.
    const isFallback =
        isCacheEntry(entry) && entry.runtime === pending && Number.isFinite(entry.expiresAt);
    return { runtime, isFallback };
}
