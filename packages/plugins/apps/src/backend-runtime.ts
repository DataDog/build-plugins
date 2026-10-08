// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import type { AuthOptionsWithDefaults, Logger } from '@dd/core/types';
import { createHash } from 'crypto';

import type { AuthCredentials } from './auth';
import { createAuthenticatedRequest, getAuthCredentials } from './auth';
import { describeRuntime, type BackendRuntime } from './runtime-names';

export { describeRuntime, type BackendRuntime };

// With it on for an org, Action Platform runs jsFunctionWithActions on Terrapin.
export const TERRAPIN_CUTOVER_FLAG = 'ap-js-high-code-terrapin-cutover';
export const ACTIVE_FEATURE_FLAGS_PATH = '/api/ui/feature-flags/get-active-feature-flags';
export const BACKEND_RUNTIME_TIMEOUT_MS = 3_000;

export const NO_CREDENTIALS_MESSAGE = `No Datadog credentials, so the default ${describeRuntime('v1')} applies.`;

export const NO_FAILURE_DETAILS = 'no details came back';

export const FAILED_LOOKUP_WARNING = `Could not determine the org's backend runtime, so the stricter checks of the ${describeRuntime('v1')} apply.`;

// The endpoint can rate-limit, so a successful lookup is reused for the life of the process; kept on
// globalThis because a dev server restart can load a fresh copy of this module.
export const RUNTIME_CACHE_KEY = Symbol.for('@datadog/vite-plugin/apps/backend-runtime');

// A failed lookup falls back to v1, which rejects valid v2 code, so it's retried after this long.
export const FAILED_LOOKUP_RETRY_MS = 60_000;

// doRequest appends the error body after the status line, which for a non-JSON reply can be a whole HTML page.
export const MAX_LOGGED_REASON_LENGTH = 200;

// doRequest's status line describes the internal endpoint rather than anything the developer can act on.
const HTTP_STATUS_LINE = /^HTTP \d{3}\b[^\n]*\n?/;

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
    return body.active_feature_flags.includes(TERRAPIN_CUTOVER_FLAG) ? 'v2' : 'v1';
}

async function lookUpBackendRuntime(
    site: string,
    credentials: AuthCredentials | undefined,
    log: Logger,
): Promise<BackendRuntime> {
    if (!credentials) {
        log.info(NO_CREDENTIALS_MESSAGE);
        return 'v1';
    }

    const doAuthenticatedRequest = createAuthenticatedRequest(credentials);
    const signal = AbortSignal.timeout(BACKEND_RUNTIME_TIMEOUT_MS);
    const body = await doAuthenticatedRequest<unknown>({
        url: `https://api.${site}${ACTIVE_FEATURE_FLAGS_PATH}`,
        type: 'json',
        retries: 0,
        signal,
    });
    const runtime = runtimeFromResponse(body);
    const runtimeName = describeRuntime(runtime);
    log.info(`Following the org's ${runtimeName}.`);
    return runtime;
}

// The expiry is set before logging, so a logger that throws can't keep the failure cached for good.
function startLookup(
    site: string,
    credentials: AuthCredentials | undefined,
    log: Logger,
): CacheEntry {
    const entry: CacheEntry = {
        runtime: lookUpBackendRuntime(site, credentials, log).catch((error: unknown) => {
            entry.expiresAt = Date.now() + FAILED_LOOKUP_RETRY_MS;
            log.warn(FAILED_LOOKUP_WARNING);
            const reason = failureReason(error);
            log.debug(`Backend runtime lookup failed: ${reason || NO_FAILURE_DETAILS}`);
            return 'v1';
        }),
        expiresAt: Number.POSITIVE_INFINITY,
    };
    return entry;
}

// String() throws on some values, such as an object without a prototype.
function failureReason(error: unknown): string {
    try {
        const message: unknown = error instanceof Error ? error.message : error;
        const details = String(message).replace(HTTP_STATUS_LINE, '');
        return details.split('\n').join('; ').slice(0, MAX_LOGGED_REASON_LENGTH);
    } catch {
        return '';
    }
}

// One entry per set of credentials, since the flag is per org. Hashed so the cache never holds
// the secrets themselves.
export function getCacheKey(site: string, credentials: AuthCredentials | undefined): string {
    if (!credentials) {
        return `${site}:none`;
    }
    const serialized = JSON.stringify(credentials);
    const credentialsHash = createHash('sha256').update(serialized).digest('hex');
    return `${site}:${credentialsHash}`;
}

export type BackendRuntimeStatus = { runtime: BackendRuntime; isFallback: boolean };

type CachedLookup = { cache: Map<string, unknown>; cacheKey: string; entry: CacheEntry };

function cachedLookup(auth: AuthOptionsWithDefaults, log: Logger): CachedLookup {
    const { site } = auth;
    const cache = getRuntimeCache();
    // The keys the build's other uploads, such as sourcemaps, send: env, else the auth option.
    const credentials = getAuthCredentials(auth);
    const cacheKey = getCacheKey(site, credentials);
    const cached = cache.get(cacheKey);
    if (isCacheEntry(cached) && cached.expiresAt > Date.now()) {
        return { cache, cacheKey, entry: cached };
    }
    const entry = startLookup(site, credentials, log);
    cache.set(cacheKey, entry);
    return { cache, cacheKey, entry };
}

// Swaps an unusable entry that never expires, such as another plugin copy's rejected one, for a
// failed lookup's. Only the call that swaps it returns true, so concurrent callers warn once.
function expireUnusableEntry({ cache, cacheKey, entry }: CachedLookup): boolean {
    if (Number.isFinite(entry.expiresAt) || cache.get(cacheKey) !== entry) {
        return false;
    }
    const runtime = Promise.resolve<BackendRuntime>('v1');
    const expiresAt = Date.now() + FAILED_LOOKUP_RETRY_MS;
    cache.set(cacheKey, { runtime, expiresAt });
    return true;
}

/**
 * v2 only while the org's backend-runtime flag is on. Never rejects: any failure, including missing
 * credentials or another plugin copy's broken cache, resolves to 'v1', and isFallback says whether
 * v1 applies only because the lookup failed. Only a failed lookup's entry expires.
 */
export async function resolveBackendRuntime(
    auth: AuthOptionsWithDefaults,
    log: Logger,
): Promise<BackendRuntimeStatus> {
    let lookup: CachedLookup | undefined;
    try {
        lookup = cachedLookup(auth, log);
        const runtime: unknown = await lookup.entry.runtime;
        if (runtime !== 'v1' && runtime !== 'v2') {
            throw new Error('Unexpected cached runtime.');
        }
        return { runtime, isFallback: Number.isFinite(lookup.entry.expiresAt) };
    } catch {
        // An entry that already expires is a failed lookup, which warned when it failed.
        if (lookup === undefined || expireUnusableEntry(lookup)) {
            log.warn(FAILED_LOOKUP_WARNING);
        }
        return { runtime: 'v1', isFallback: true };
    }
}
