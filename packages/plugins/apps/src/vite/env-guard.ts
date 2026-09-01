// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';
import { fileURLToPath } from 'url';

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

// fs path arguments can legally be a string, a Buffer, or a file:// URL — checking only the string
// case let a Buffer/URL argument to any of the guarded functions bypass the check entirely.
function toPathString(path: unknown): string | undefined {
    if (typeof path === 'string') {
        return path;
    }
    if (Buffer.isBuffer(path)) {
        return path.toString();
    }
    if (path instanceof URL) {
        return fileURLToPath(path);
    }
    return undefined;
}

function isEnvironPath(path: unknown): boolean {
    const pathString = toPathString(path);
    return pathString !== undefined && ENVIRON_PATH_RE.test(pathString);
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

// createReadStream/open/openSync/promises.open are separate entry points that map a path to
// readable bytes or a file descriptor without going through readFile*, so they need the same guard.
const realCreateReadStream = fs.createReadStream;
fs.createReadStream = ((path: fs.PathLike, ...rest: unknown[]) => {
    guardEnvironPath(path);
    return (realCreateReadStream as (...args: unknown[]) => unknown)(path, ...rest);
}) as typeof fs.createReadStream;

const realOpenSync = fs.openSync;
fs.openSync = ((path: fs.PathLike, ...rest: unknown[]) => {
    guardEnvironPath(path);
    return (realOpenSync as (...args: unknown[]) => unknown)(path, ...rest);
}) as typeof fs.openSync;

const realOpen = fs.open;
fs.open = ((path: fs.PathLike, ...rest: unknown[]) => {
    guardEnvironPath(path);
    return (realOpen as (...args: unknown[]) => unknown)(path, ...rest);
}) as typeof fs.open;

const realPromisesOpen = fs.promises.open;
fs.promises.open = (async (path: Parameters<typeof fs.promises.open>[0], ...rest: unknown[]) => {
    guardEnvironPath(path);
    return (realPromisesOpen as (...args: unknown[]) => unknown)(path, ...rest);
}) as typeof fs.promises.open;

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
