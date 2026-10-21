// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/** Contracts and limits local execution shares between the dev server and each call's process. */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { LongPollingOptions } from '../types';
import { resolveLongPolling } from '../validate';

import { isIndexableRecord } from './local-execution-shared';
import { getTotalRetryDelayBudgetMs } from './retry-delay';

type RuntimeUser = {
    id: string;
    orgId: string;
    email?: string | null;
    name?: string | null;
};

export type RuntimeContext = Record<string, unknown> & {
    Source: {
        initiator: RuntimeUser;
        runAsUser: RuntimeUser;
    };
};

/** Scopes vite/index.ts's suffixed-subgraph tracking to one call's module loads, so a later unrelated SSR resolution of a helper never inherits the marker and serves real backend code instead of the frontend proxy stub. */
export const localExecutionResolutionContext = new AsyncLocalStorage<Set<string>>();

function assertRuntimeUser(value: unknown, label: string): asserts value is RuntimeUser {
    if (!isIndexableRecord(value) || Array.isArray(value)) {
        throw new Error(`The preview runtime context ${label} must be an object.`);
    }
    if (typeof value.id !== 'string' || value.id.length === 0) {
        throw new Error(
            `The preview runtime context ${label} must have a non-empty string "id" field.`,
        );
    }
    if (typeof value.orgId !== 'string' || value.orgId.length === 0) {
        throw new Error(
            `The preview runtime context ${label} must have a non-empty string "orgId" field.`,
        );
    }
    if (value.email !== undefined && value.email !== null && typeof value.email !== 'string') {
        throw new Error(
            `The preview runtime context ${label} must have a string "email" field when provided.`,
        );
    }
    if (value.name !== undefined && value.name !== null && typeof value.name !== 'string') {
        throw new Error(
            `The preview runtime context ${label} must have a string "name" field when provided.`,
        );
    }
}

/** Validates the identity-bearing minimum of the preview-provided `$` snapshot before any customer module is loaded. */
export function assertValidRuntimeContext(value: unknown): asserts value is RuntimeContext {
    if (!isIndexableRecord(value) || Array.isArray(value)) {
        throw new Error('The preview runtime context must be an object.');
    }
    const source = value.Source;
    if (!isIndexableRecord(source) || Array.isArray(source)) {
        throw new Error('The preview runtime context must have a "Source" object.');
    }
    assertRuntimeUser(source.initiator, 'Source.initiator');
    assertRuntimeUser(source.runAsUser, 'Source.runAsUser');
}

export const DEFAULT_TIMEOUT_MS = 10_000;

type LongPollingConfig = Required<LongPollingOptions>;

// Derived from validate.ts's own resolveLongPolling rather than a hardcoded copy, so callers get
// the same effective ceilings a real dev server derives without each passing one in.
export const DEFAULT_LONG_POLLING_CONFIG: LongPollingConfig = resolveLongPolling(undefined);

/**
 * Both ceilings must exceed `pollQueryExecution`'s worst-case budget: polling time
 * (`maxRetries * timeoutMs`) plus the retry-delay budget. Exported so tests compute the expected
 * value instead of hardcoding a copy.
 */
export function deriveActionTimeouts(longPolling: LongPollingConfig): {
    actionCallTimeoutMs: number;
    totalExecutionTimeoutMs: number;
} {
    const worstCaseMs =
        longPolling.maxRetries * longPolling.timeoutMs + getTotalRetryDelayBudgetMs(longPolling);
    return {
        // Bounds a single $.Actions call, exempt from the hang-detection timer — doRequest has
        // no deadline of its own, so an unsettled call would wedge the whole serialized queue.
        actionCallTimeoutMs: worstCaseMs * 2,
        // Absolute wall-clock ceiling, independent of the pause-and-extend mechanism above —
        // that can't tell a genuinely slow $.Actions call from a fire-and-forgot one masking a
        // real hang, so this bounds the masked case tighter without cutting off legitimate calls.
        totalExecutionTimeoutMs: worstCaseMs * 1.2,
    };
}

/** Executes a real `$.Actions.foo.bar(...)` call; the dev server supplies the implementation using its own auth, so this module never holds or sees a credential itself. */
export type ExecuteAction = (
    fqn: string,
    inputs: unknown,
    connectionId: string | undefined,
) => Promise<unknown>;

/** Resolves a fresh serializable `$` snapshot from an authenticated preview execution. */
export type GetRuntimeContext = () => Promise<unknown>;

/** Runs local executions one at a time, in arrival order. */
let queueTail: Promise<unknown> = Promise.resolve();

export function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = queueTail.then(run);
    queueTail = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

/** Bounds a promise that could otherwise hang forever, such as a `$.Actions` call with no deadline of its own, without cancelling it. `label` is the full subject of the timeout message. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err: unknown) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}
