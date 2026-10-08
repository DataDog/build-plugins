// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import type { Logger } from '@dd/core/types';

import type { DoAuthenticatedRequest } from './auth';
import {
    BACKEND_RUNTIMES,
    DATATRANSFORMATION_BUNDLE_ID,
    FAILED_LOOKUP_RETRY_MS,
    RUNTIME_ACTION_NAMES,
    summarizeRequestError,
    type BackendRuntime,
} from './backend-runtime';

export const DATATRANSFORMATION_MANIFEST_PATH = `/api/v2/workflow_actions/${DATATRANSFORMATION_BUNDLE_ID}`;
export const SCRIPT_LIMITS_TIMEOUT_MS = 3_000;

export type ScriptMaxLengths = Partial<Record<BackendRuntime, number>>;

// Kept on globalThis for the same reason as the backend runtime lookup: a dev server restart can
// load a fresh copy of this module.
export const SCRIPT_LIMITS_CACHE_KEY = Symbol.for('@datadog/vite-plugin/apps/script-limits');

type CacheEntry = { limits: Promise<ScriptMaxLengths>; expiresAt: number };

// Another copy of the plugin in the process may have stored a different shape under the same key.
function isCacheEntry(value: unknown): value is CacheEntry {
    return (
        typeof value === 'object' &&
        value !== null &&
        'limits' in value &&
        value.limits instanceof Promise &&
        'expiresAt' in value &&
        typeof value.expiresAt === 'number'
    );
}

function getScriptLimitsCache(): Map<string, unknown> {
    const existing: unknown = Reflect.get(globalThis, SCRIPT_LIMITS_CACHE_KEY);
    if (existing instanceof Map) {
        return existing;
    }
    const cache = new Map<string, unknown>();
    Reflect.set(globalThis, SCRIPT_LIMITS_CACHE_KEY, cache);
    return cache;
}

// Test-only escape hatch: forgets every memoized lookup.
export function resetScriptLimitsCache(): void {
    getScriptLimitsCache().clear();
}

// The manifest keys each action's input schema by its TypeScript type name.
export function getInputsDefName(runtime: BackendRuntime): string {
    const actionName = RUNTIME_ACTION_NAMES[runtime];
    return `${actionName.charAt(0).toUpperCase()}${actionName.slice(1)}Inputs`;
}

export function getProperty(value: unknown, key: string): unknown {
    return typeof value === 'object' && value !== null && key in value
        ? Reflect.get(value, key)
        : undefined;
}

function readScriptMaxLengths(body: unknown): ScriptMaxLengths {
    const defs = ['data', 'attributes', 'types', '$defs'].reduce(getProperty, body);
    const limits: ScriptMaxLengths = {};
    for (const runtime of BACKEND_RUNTIMES) {
        const inputsDefName = getInputsDefName(runtime);
        const inputs = getProperty(defs, inputsDefName);
        const maxLength = ['properties', 'script', 'maxLength'].reduce(getProperty, inputs);
        if (typeof maxLength === 'number' && Number.isInteger(maxLength) && maxLength > 0) {
            limits[runtime] = maxLength;
        }
    }
    return limits;
}

type LookupResult = { limits: ScriptMaxLengths; failed: boolean };

async function lookUpScriptMaxLengths(
    site: string,
    doAuthenticatedRequest: DoAuthenticatedRequest,
    log: Logger,
): Promise<LookupResult> {
    try {
        const signal = AbortSignal.timeout(SCRIPT_LIMITS_TIMEOUT_MS);
        const body = await doAuthenticatedRequest<unknown>({
            url: `https://api.${site}${DATATRANSFORMATION_MANIFEST_PATH}`,
            type: 'json',
            retries: 0,
            signal,
        });
        const limits = readScriptMaxLengths(body);
        log.debug(`Backend function script limits: ${JSON.stringify(limits)}`);
        // A reply with no limit in it is retried too, since it may be transient.
        return { limits, failed: Object.keys(limits).length === 0 };
    } catch (error) {
        const reason = summarizeRequestError(error);
        log.debug(
            `Could not read the backend function script limits, so only Datadog enforces them: ${reason}`,
        );
        return { limits: {}, failed: true };
    }
}

/**
 * Reads each runtime action's `script.maxLength` from the live action manifest. A successful read
 * lasts the process; after a failed or empty one, the next call at least
 * `FAILED_LOOKUP_RETRY_MS` later reads again.
 * Never rejects: a runtime whose limit can't be read is left out.
 */
export function resolveScriptMaxLengths(
    site: string,
    doAuthenticatedRequest: DoAuthenticatedRequest,
    log: Logger,
): Promise<ScriptMaxLengths> {
    const cache = getScriptLimitsCache();
    const cached = cache.get(site);
    if (isCacheEntry(cached) && cached.expiresAt > Date.now()) {
        return cached.limits;
    }

    const lookup = lookUpScriptMaxLengths(site, doAuthenticatedRequest, log);
    const entry: CacheEntry = {
        limits: lookup.then(({ limits, failed }) => {
            if (failed) {
                entry.expiresAt = Date.now() + FAILED_LOOKUP_RETRY_MS;
            }
            return limits;
        }),
        expiresAt: Number.POSITIVE_INFINITY,
    };
    cache.set(site, entry);
    return entry.limits;
}
