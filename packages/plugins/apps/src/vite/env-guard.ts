// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';

import { createEpochGuard } from './execution-epoch';

// Scopes process.env to a from-scratch allowlist during local execution, since there's no process boundary here (unlike prod's per-execution Deno subprocess with --allow-env) to stop customer code from reading the dev server's real environment, including its own credentials; also blocks the /proc/.../environ backing-store bypass on Linux, which swapping process.env alone doesn't stop.

const SAFE_ENV_KEYS = ['PATH', 'HOME', 'NODE_ENV', 'TMPDIR'] as const;

// customCredentials is currently always {} — Custom Credential resolution for local execution is still undecided, so those values stay unset here rather than read from the real environment.
export function buildScopedEnv(customCredentials: Record<string, string>): Record<string, string> {
    const scoped: Record<string, string> = {};
    for (const key of SAFE_ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) {
            scoped[key] = value;
        }
    }
    return { ...scoped, ...customCredentials };
}

let savedEnv: typeof process.env | undefined;

// Guards against an abandoned execution's scoped-env window settling after a newer execution has already started its own, mirroring network-guard.ts's and local-execution.ts's abandonment handling.
const envEpoch = createEpochGuard();

// Clears savedEnv immediately after consuming it so a later, idle forceResetEnv() call can't reinstall a stale snapshot over a real env change made since.
function restoreEnv(): void {
    if (savedEnv) {
        process.env = savedEnv;
        savedEnv = undefined;
    }
}

const ENVIRON_PATH_RE = new RegExp(`^/proc/(self|${process.pid})/environ$`);

function isEnvironPath(path: unknown): boolean {
    return typeof path === 'string' && ENVIRON_PATH_RE.test(path);
}

function guardEnvironPath(path: unknown): void {
    if (envEpoch.hasActiveScope() && isEnvironPath(path)) {
        throw new Error(
            "Reading /proc/.../environ is not allowed in backend functions — it exposes the dev server's real, unscoped environment. Use $.Source or a declared Custom Credential instead.",
        );
    }
}

const realReadFileSync = fs.readFileSync;
fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    guardEnvironPath(path);
    return (realReadFileSync as (...args: unknown[]) => unknown)(path, ...rest);
}) as typeof fs.readFileSync;

const realReadFile = fs.readFile;
fs.readFile = ((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    guardEnvironPath(path);
    return (realReadFile as (...args: unknown[]) => unknown)(path, ...rest);
}) as typeof fs.readFile;

const realPromisesReadFile = fs.promises.readFile;
fs.promises.readFile = (async (
    path: Parameters<typeof fs.promises.readFile>[0],
    ...rest: unknown[]
) => {
    guardEnvironPath(path);
    return (realPromisesReadFile as (...args: unknown[]) => unknown)(path, ...rest);
}) as typeof fs.promises.readFile;

// Wraps only the customer function's own call in local-execution.ts's runScriptLocally, matching runBlocked's scope exactly.
export async function runWithScopedEnv<T>(
    scopedEnv: Record<string, string>,
    fn: () => Promise<T>,
): Promise<T> {
    const scope = envEpoch.start();
    savedEnv = process.env;
    process.env = scopedEnv;
    try {
        return await fn();
    } finally {
        if (scope.concludeIfCurrent()) {
            restoreEnv();
        }
    }
}

// Unconditionally restores the real process.env, for an abandoned/timed-out execution whose fn never reaches runWithScopedEnv's own finally; safe to call when idle.
export function forceResetEnv(): void {
    envEpoch.forceInvalidate();
    restoreEnv();
}
