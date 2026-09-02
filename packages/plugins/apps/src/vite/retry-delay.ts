// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { LongPollingOptions } from '../types';

type LongPollingConfig = Required<LongPollingOptions>;

// Kept small: `done: false` is healthy, so this delay is dead time. It only
// exists to de-synchronize concurrent pollers.
export const RETRY_BASE_DELAY_MS = 250;
export const RETRY_MAX_DELAY_MS = 2_000;

/** Deterministic upper bound for one retry delay, ignoring jitter's random reduction — dev-server.ts's `getRetryDelay` only ever reduces toward this ceiling, never past it, so it also bounds the worst-case budget below. */
export function getMaxRetryDelayMs(attempt: number, exponentialBackoff: boolean): number {
    return exponentialBackoff
        ? Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS)
        : RETRY_BASE_DELAY_MS;
}

/** Worst-case total time `pollQueryExecution` spends waiting between attempts — shared so `deriveActionTimeouts`'s ceilings can't drift from the delays it actually waits out. */
export function getTotalRetryDelayBudgetMs(config: LongPollingConfig): number {
    let totalMs = 0;
    for (let attempt = 1; attempt < config.maxRetries; attempt++) {
        totalMs += getMaxRetryDelayMs(attempt, config.exponentialBackoff);
    }
    return totalMs;
}
