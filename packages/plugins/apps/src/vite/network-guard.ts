// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import child_process from 'child_process';
import net from 'net';

/**
 * Closes a gap the build-time checks in `../backend/ast-parsing` can't reach:
 * those only scan the customer's own `*.backend.ts` file, so a third-party
 * dependency's own internal `net`/`http`/`fetch` usage (e.g. a Postgres or
 * Redis client) is invisible to them. Production's Deno sandbox closes the
 * equivalent gap at the OS level (it never grants `--allow-net`, under any
 * code path — see `wf-actions-worker`'s `deno.ts`); in-process local
 * execution has no process boundary to fall back on, so this closes it at
 * the module level instead: block every JS-level path to a real socket for
 * the duration of a local execution, and exempt only the one sanctioned
 * network call (`$.Actions` → `executeAction`).
 *
 * Known residual gap, accepted rather than engineered around: a native
 * addon that bypasses Node's JS-level `net` stack entirely via its own
 * compiled code. Narrower and rarer than the pure-JS case this closes —
 * most native modules are for CPU-bound work (crypto, image processing),
 * not networking.
 */

const NETWORK_BLOCKED_MESSAGE =
    'Network access is not allowed directly in backend functions — use $.Actions instead.';
const SUBPROCESS_BLOCKED_MESSAGE = 'Spawning a subprocess is not allowed in backend functions.';

function throwNetworkBlocked(): never {
    throw new Error(NETWORK_BLOCKED_MESSAGE);
}

/**
 * `fetch`'s real contract is to always return a Promise, rejecting on
 * failure rather than throwing synchronously — a synchronous throw here
 * would break any caller using `.catch()` or `expect(...).rejects` directly
 * on the call, instead of surfacing as an ordinary fetch failure.
 */
function rejectNetworkBlocked(): Promise<never> {
    return Promise.reject(new Error(NETWORK_BLOCKED_MESSAGE));
}

function throwSubprocessBlocked(): never {
    throw new Error(SUBPROCESS_BLOCKED_MESSAGE);
}

let savedConnect: typeof net.Socket.prototype.connect | undefined;
let savedFetch: typeof fetch | undefined;
let savedSpawn: typeof child_process.spawn | undefined;
let savedExec: typeof child_process.exec | undefined;
let savedExecSync: typeof child_process.execSync | undefined;

/**
 * Captures whatever is currently installed (the real implementation, or a
 * test's mock standing in for it) before overwriting it — never a
 * module-load-time snapshot. That's what makes `runAllowed`'s nested
 * restore/re-apply correct: each pair captures-then-restores exactly the
 * state it found, so nesting composes regardless of call order.
 */
function applyPatches(): void {
    savedConnect = net.Socket.prototype.connect;
    savedFetch = globalThis.fetch;
    savedSpawn = child_process.spawn;
    savedExec = child_process.exec;
    savedExecSync = child_process.execSync;

    net.Socket.prototype.connect = throwNetworkBlocked as typeof net.Socket.prototype.connect;
    globalThis.fetch = rejectNetworkBlocked as typeof fetch;
    child_process.spawn = throwSubprocessBlocked as typeof child_process.spawn;
    // `exec`'s type carries a `__promisify__` property (it supports
    // `util.promisify(exec)`) that a plain function type doesn't
    // structurally satisfy — going through `unknown` is the correct escape
    // hatch here, not a sign the cast is wrong.
    child_process.exec = throwSubprocessBlocked as unknown as typeof child_process.exec;
    child_process.execSync = throwSubprocessBlocked as typeof child_process.execSync;
}

function restorePatches(): void {
    if (savedConnect) {
        net.Socket.prototype.connect = savedConnect;
    }
    if (savedFetch) {
        globalThis.fetch = savedFetch;
    }
    if (savedSpawn) {
        child_process.spawn = savedSpawn;
    }
    if (savedExec) {
        child_process.exec = savedExec;
    }
    if (savedExecSync) {
        child_process.execSync = savedExecSync;
    }
}

/**
 * Runs `fn` with network/subprocess access blocked. Intended to wrap an
 * entire local execution (the customer's function body) in
 * `local-execution.ts`'s `runScriptLocally`.
 */
export async function runBlocked<T>(fn: () => Promise<T>): Promise<T> {
    applyPatches();
    try {
        return await fn();
    } finally {
        restorePatches();
    }
}

/**
 * Temporarily restores real network access for the duration of `fn`. Only
 * meaningful when called from inside an active `runBlocked` scope — used by
 * `makeActionsProxy`'s `apply` trap to exempt the one sanctioned network
 * call (`executeAction`) without exposing real network to anything else the
 * customer's function does.
 *
 * Ref-counted rather than a boolean: two `$.Actions` calls can legitimately
 * overlap within a single execution (e.g. `Promise.all([...])`), and a
 * boolean would re-block network the instant the first of two concurrent
 * calls finishes, breaking the second one mid-flight.
 */
let allowDepth = 0;

export async function runAllowed<T>(fn: () => Promise<T>): Promise<T> {
    allowDepth += 1;
    if (allowDepth === 1) {
        restorePatches();
    }
    try {
        return await fn();
    } finally {
        allowDepth -= 1;
        if (allowDepth === 0) {
            applyPatches();
        }
    }
}
