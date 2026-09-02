// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';
import { syncBuiltinESMExports } from 'node:module';
import nodePath from 'path';
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
let savedExcludeEnv: boolean | undefined;

// Guards against an abandoned execution's scoped-env window settling after a newer execution has already started its own, mirroring network-guard.ts's and local-execution.ts's abandonment handling.
const envEpoch = createEpochGuard();

// Clears savedEnv immediately after consuming it so a later, idle forceResetEnv() call can't reinstall a stale snapshot over a real env change made since.
function restoreEnv(): void {
    if (savedEnv) {
        process.env = savedEnv;
        savedEnv = undefined;
        processReport.excludeEnv = savedExcludeEnv;
        savedExcludeEnv = undefined;
    }
}

const ENVIRON_PATH_RE = new RegExp(`^/proc/(self|thread-self|${process.pid})/environ$`);

// fs path arguments can legally be a string, a Buffer, or a file:// URL — checking only the string
// case let a Buffer/URL argument to any of the guarded functions bypass the check entirely.
function toPathString(rawPath: unknown): string | undefined {
    if (typeof rawPath === 'string') {
        return rawPath;
    }
    if (Buffer.isBuffer(rawPath)) {
        return rawPath.toString();
    }
    if (rawPath instanceof URL) {
        return fileURLToPath(rawPath);
    }
    return undefined;
}

function isEnvironPath(rawPath: unknown): boolean {
    const pathString = toPathString(rawPath);
    if (pathString === undefined) {
        return false;
    }
    // Normalized before testing: an unnormalized path like /proc/self/../self/environ resolves to
    // the same file on Linux but wouldn't match the regex literally.
    return ENVIRON_PATH_RE.test(nodePath.posix.normalize(pathString));
}

function guardEnvironPath(rawPath: unknown): void {
    if (envEpoch.hasActiveScope() && isEnvironPath(rawPath)) {
        throw new Error(
            "Reading /proc/.../environ is not allowed in backend functions — it exposes the dev server's real, unscoped environment. Use $.Source or a declared Custom Credential instead.",
        );
    }
}

// Every guarded fs entry point takes a leading path argument and forwards the rest unchanged —
// wraps that shared shape once instead of repeating it per function. Sync and callback-style
// functions (readFileSync, readFile, createReadStream, openSync, open) must throw synchronously
// on a guard failure, matching their real Node contract and what callers of a sync API expect.
function wrapGuardedFsFn<Args extends unknown[], R>(
    real: (...args: Args) => R,
): (...args: Args) => R {
    return (...args: Args): R => {
        guardEnvironPath(args[0]);
        return real(...args);
    };
}

// fs.promises.* functions must reject rather than throw synchronously on a guard failure, matching
// their real Promise-returning contract — the `async` wrapper here converts guardEnvironPath's
// throw into a rejection automatically.
function wrapGuardedAsyncFsFn<Args extends unknown[], R>(
    real: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
    return async (...args: Args): Promise<R> => {
        guardEnvironPath(args[0]);
        return real(...args);
    };
}

// createReadStream/open/openSync/promises.open are separate entry points that map a path to
// readable bytes or a file descriptor without going through readFile*, so they need the same guard.
fs.readFileSync = wrapGuardedFsFn(fs.readFileSync) as typeof fs.readFileSync;
fs.readFile = wrapGuardedFsFn(fs.readFile) as typeof fs.readFile;
fs.promises.readFile = wrapGuardedAsyncFsFn(fs.promises.readFile) as typeof fs.promises.readFile;
fs.createReadStream = wrapGuardedFsFn(fs.createReadStream) as typeof fs.createReadStream;
fs.openSync = wrapGuardedFsFn(fs.openSync) as typeof fs.openSync;
fs.open = wrapGuardedFsFn(fs.open) as typeof fs.open;
fs.promises.open = wrapGuardedAsyncFsFn(fs.promises.open) as typeof fs.promises.open;

// @types/node doesn't declare excludeEnv yet. It's real, but only wired up to the native report
// generator from Node v22.0.0 — CI pins Node 20.19.4, where setting it is a silent no-op, so it
// alone doesn't close this gap on every Node version this repo supports. Kept anyway: on versions
// that do support it, it also covers reports Node generates on its own via --report-on-fatalerror/
// --report-on-signal, which the getReport()/writeReport() wraps below can't reach since no JS call
// happens for those.
interface ProcessReportWithExcludeEnv {
    excludeEnv?: boolean;
}
const processReport = process.report as unknown as ProcessReportWithExcludeEnv;

type ReportLike = Record<string, unknown> & { environmentVariables?: unknown };

// Strips environmentVariables at the JS level so a customer function's own getReport()/
// writeReport() call is redacted on every supported Node version, not just where excludeEnv is
// wired up. writeReport() lets Node handle filename generation/defaults as normal, then
// post-processes the file it actually wrote rather than reimplementing its naming convention.
const originalGetReport = process.report.getReport.bind(process.report);
process.report.getReport = ((...args: Parameters<typeof process.report.getReport>) => {
    const report = originalGetReport(...args) as ReportLike;
    if (envEpoch.hasActiveScope()) {
        delete report.environmentVariables;
    }
    return report;
}) as typeof process.report.getReport;

const originalWriteReport = process.report.writeReport.bind(process.report);
process.report.writeReport = ((...args: Parameters<typeof process.report.writeReport>) => {
    const filename = originalWriteReport(...args);
    if (envEpoch.hasActiveScope()) {
        const report = JSON.parse(fs.readFileSync(filename, 'utf8')) as ReportLike;
        delete report.environmentVariables;
        fs.writeFileSync(filename, JSON.stringify(report, null, 2));
    }
    return filename;
}) as typeof process.report.writeReport;

// installGuardedProperty in network-guard.ts only patches the CJS-style default-export object;
// Node keeps ESM named bindings (e.g. `import { readFileSync } from 'node:fs'`) as separate
// references that stay bound to the original native functions otherwise.
syncBuiltinESMExports();

// Wraps only the customer function's own call in local-execution.ts's runScriptLocally, matching runBlocked's scope exactly.
export async function runWithScopedEnv<T>(
    scopedEnv: Record<string, string>,
    fn: () => Promise<T>,
): Promise<T> {
    const scope = envEpoch.start();
    savedEnv = process.env;
    process.env = scopedEnv;
    // process.report.getReport()/writeReport() read the OS-level environment table directly,
    // bypassing the process.env swap above entirely — the wraps above cover JS-triggered calls on
    // every Node version; this also sets excludeEnv for the auto-triggered case on versions that
    // support it (see the wraps' own comment for why both exist).
    savedExcludeEnv = processReport.excludeEnv;
    processReport.excludeEnv = true;
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
