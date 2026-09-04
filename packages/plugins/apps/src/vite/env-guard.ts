// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global NodeJS, Proxy */

import fs from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { syncBuiltinESMExports } from 'node:module';
import nodePath from 'path';
import { fileURLToPath } from 'url';

import { makeGuardCallbackWrapper, makeGuardWrapper } from './guarded-wrapper';
import { getOrCreateShared } from './shared-module-singleton';

// Scopes process.env to a from-scratch allowlist during local execution — production isolates
// each execution in its own Deno subprocess with --allow-env, but local execution has no process
// boundary, so this also blocks the /proc/.../environ backing-store bypass on Linux that swapping
// process.env alone wouldn't stop.
//
// JS-level defense-in-depth only, not a hard security boundary (matches network-guard.ts): a
// callback that escapes its own AsyncLocalStorage continuation entirely — a FinalizationRegistry
// finalizer, for example — can reassign process.env indistinguishably from a legitimate
// post-scope reload, letting attacker-controlled data become the real-environment fallback for
// every later execution.

export const SAFE_ENV_KEYS = ['PATH', 'HOME', 'NODE_ENV', 'TMPDIR'] as const;

// customCredentials is currently always {} — Custom Credential resolution for local execution is still undecided, so those values stay unset here rather than read from the real environment.
export function buildScopedEnv(customCredentials: Record<string, string>): Record<string, string> {
    const scoped: Record<string, string> = {};
    for (const key of SAFE_ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) {
            scoped[key] = value;
        }
    }
    const merged = { ...scoped, ...customCredentials };
    if (process.platform !== 'win32') {
        return merged;
    }
    // On win32, Node's real process.env is case-insensitive (e.g. .Path and .PATH read the same
    // value), but `merged` is a plain object. Without this, customer code reading a SAFE_ENV_KEYS
    // entry under any casing other than its canonical uppercase form gets undefined during local
    // execution even though the same read against the real environment would succeed.
    return new Proxy(merged, {
        get(target, prop, receiver) {
            if (typeof prop === 'string' && !(prop in target)) {
                const canonicalKey = SAFE_ENV_KEYS.find(
                    (key) => key.toLowerCase() === prop.toLowerCase(),
                );
                if (canonicalKey) {
                    return Reflect.get(target, canonicalKey, receiver);
                }
            }
            return Reflect.get(target, prop, receiver);
        },
        has(target, prop) {
            if (typeof prop === 'string' && !(prop in target)) {
                return SAFE_ENV_KEYS.some((key) => key.toLowerCase() === prop.toLowerCase());
            }
            return Reflect.has(target, prop);
        },
        // Without this, a write through a non-canonical casing (e.g. .Path when only .PATH exists)
        // falls through to the default set behavior and creates a second, separate own property
        // instead of updating the canonical one — leaving PATH/Path/path to disagree within the
        // same scope, breaking the case-insensitivity the get/has traps above establish for reads.
        set(target, prop, value) {
            if (typeof prop === 'string' && !(prop in target)) {
                const canonicalKey = SAFE_ENV_KEYS.find(
                    (key) => key.toLowerCase() === prop.toLowerCase(),
                );
                if (canonicalKey) {
                    return Reflect.set(target, canonicalKey, value);
                }
            }
            return Reflect.set(target, prop, value);
        },
    });
}

/** Everything a re-evaluation of this file needs to share with every other re-evaluation — see getSharedState()'s own comment for why this can't just be module-level `let`s. */
interface SharedEnvGuardState {
    scopedEnvContext: AsyncLocalStorage<Record<string, string>>;
    realEnv: NodeJS.ProcessEnv;
    activeScopeCount: number;
    savedExcludeEnv: boolean | undefined;
    // Bumped by forceResetEnv() so a zombie scope's delayed finally can detect it was forcibly
    // closed out already, and skip re-applying its decrement/restore against whatever different,
    // still-running scope has since claimed the shared activeScopeCount.
    resetEpoch: number;
    // process.report.excludeEnv already has a native getter/setter of its own (Node validates the
    // assigned value there), so "does it already have an accessor" can't tell our guarded version
    // apart from Node's own stock one — this is the actual install marker, checked instead.
    excludeEnvGuardInstalled: boolean;
    // The raw, unguarded apply function — runWithScopedEnv's own arm/disarm calls this directly
    // instead of the public `processReport.excludeEnv =` accessor, since that accessor defers any
    // write made while a scope is active and would otherwise swallow the framework's own trusted call.
    applyExcludeEnvValue: (newValue: boolean | undefined) => void;
}

// Keyed on the real `fs` module, via the same getOrCreateShared() helper network-guard.ts uses:
// this file gets evaluated more than once (bundled copies, Jest's per-test-file isolation), and
// every evaluation must share the same scopedEnvContext/realEnv/activeScopeCount or a later
// evaluation's Proxy would never consult the storage an earlier evaluation's scope populates.
function getSharedState(): SharedEnvGuardState {
    return getOrCreateShared(fs, '@dd/apps-plugin/env-guard shared-state', () => ({
        scopedEnvContext: new AsyncLocalStorage<Record<string, string>>(),
        realEnv: process.env,
        activeScopeCount: 0,
        savedExcludeEnv: undefined,
        resetEpoch: 0,
        excludeEnvGuardInstalled: false,
        applyExcludeEnvValue: () => {},
    }));
}

const sharedState = getSharedState();

// Symbol.for(), not a plain Symbol() or object-identity check — same cross-module-instance reasoning
// as getSharedState() above: a reference-identity check would fail to recognize another evaluation's
// already-installed Proxy as "already one of these," and each would wrap the other's, looping the
// get/ownKeys/etc. traps into each other forever.
const ENV_PROXY_MARKER = Symbol.for('@dd/apps-plugin/env-guard/scoped-env-proxy');

// Takes `unknown`, not NodeJS.ProcessEnv: the setter below calls this on whatever a caller actually
// assigns to process.env at runtime, which TypeScript's parameter typing can't constrain — a bare
// `Reflect.get(value, ...)` throws for null/undefined/primitives, which would surface as a confusing
// native TypeError instead of either this file's own clear rejection message or a graceful no-op.
function isEnvProxy(value: unknown): boolean {
    return (
        typeof value === 'object' && value !== null && Reflect.get(value, ENV_PROXY_MARKER) === true
    );
}

function currentEnv(): Record<string, string> | NodeJS.ProcessEnv {
    return sharedState.scopedEnvContext.getStore() ?? sharedState.realEnv;
}

// Shared by every Proxy trap below that does nothing but forward to currentEnv() with no extra
// logic of its own — get/has are hand-written instead, since both also short-circuit ENV_PROXY_MARKER.
function forwardToCurrentEnv<Args extends unknown[], R>(
    reflectFn: (env: Record<string, string> | NodeJS.ProcessEnv, ...args: Args) => R,
): (_target: NodeJS.ProcessEnv, ...args: Args) => R {
    return (_target, ...args) => {
        const env = currentEnv();
        return reflectFn(env, ...args);
    };
}

// Shared by process.env's own reassignment setter below and process.report.excludeEnv's later in
// this file — both reject a reassignment made BY code running inside its own active scope, so
// trusted reassignment from outside any scope (a test's own isolation swap, a dotenv-style tool)
// keeps working exactly as before, even while some OTHER, unrelated scope happens to be
// concurrently active.
function assertNotInsideActiveScope(errorMessage: string): void {
    if (sharedState.scopedEnvContext.getStore() !== undefined) {
        throw new Error(errorMessage);
    }
}

// Re-checked on every runWithScopedEnv call rather than installed once and assumed permanent, since
// isEnvProxy() is what actually detects "is this already installed" — the accessor property below
// makes a bare `process.env = X` (rather than a call through this function) impossible to reach the
// real Proxy install path with, but this function still needs to stay idempotent across every
// evaluation of this file (bundled copies, Jest's per-test-file isolation) that calls it.
function ensureEnvProxyInstalled(): void {
    if (isEnvProxy(process.env)) {
        return;
    }
    sharedState.realEnv = process.env;
    const proxy = new Proxy(sharedState.realEnv, {
        get: (_target, prop, receiver) => {
            if (prop === ENV_PROXY_MARKER) {
                return true;
            }
            const env = currentEnv();
            return Reflect.get(env, prop, receiver);
        },
        // Not forwardToCurrentEnv(Reflect.set): a plain `process.env[key] = value` passes the Proxy
        // itself as `receiver`, which for an existing writable property falls back to a PARTIAL
        // descriptor that Node's native process.env binding rejects outright. Omitting `receiver`
        // from Reflect.set defaults it to `env` itself, resolving as a direct set instead.
        set: (_target, prop, value) => Reflect.set(currentEnv(), prop, value),
        has: (_target, prop) => {
            const env = currentEnv();
            return prop === ENV_PROXY_MARKER || Reflect.has(env, prop);
        },
        deleteProperty: forwardToCurrentEnv(Reflect.deleteProperty),
        ownKeys: forwardToCurrentEnv(Reflect.ownKeys),
        getOwnPropertyDescriptor: forwardToCurrentEnv(Reflect.getOwnPropertyDescriptor),
        defineProperty: forwardToCurrentEnv(Reflect.defineProperty),
        // Without this trap, Object.setPrototypeOf(process.env, ...) defaults to forwarding to
        // `target` (the real, unscoped env object) and silently poisons its prototype chain
        // permanently, even when called from inside a scope — since currentEnv() only affects
        // property access, not the object identity a prototype mutation lands on.
        setPrototypeOf: forwardToCurrentEnv(Reflect.setPrototypeOf),
        // Paired with setPrototypeOf above: without this trap, a customer function that sets a
        // scoped prototype and immediately reads it back would see `target`'s (the real env's)
        // untouched prototype instead of the one it just set on the scoped view.
        getPrototypeOf: forwardToCurrentEnv(Reflect.getPrototypeOf),
        // Can't forward to currentEnv(): the Proxy invariants only honor a `preventExtensions` trap
        // returning `true` if `target` (always the real env object) is also non-extensible, so
        // routing this to the scoped object would either desync the invariant or force freezing the
        // real env process-wide. Refusing outright is the only option that risks neither.
        preventExtensions: () => false,
    });
    // process.env must be an accessor property, not the plain data property it started as — a bare
    // `process.env = X` replaces `process`'s own `env` property outright, bypassing every Proxy
    // trap above, and the next runWithScopedEnv call would silently adopt that customer-controlled
    // object as the new realEnv fallback for every later execution. configurable: false so nothing
    // can strip this accessor back to a plain data property.
    Object.defineProperty(process, 'env', {
        configurable: false,
        enumerable: true,
        get: () => proxy,
        set: (newValue: NodeJS.ProcessEnv) => {
            // A no-op: something captured process.env (getting this same proxy back, e.g. a test's
            // own `const saved = process.env; ...; process.env = saved;` restore pattern) and wrote
            // it back unchanged. Must short-circuit before the realEnv assignment below — adopting
            // the proxy as its own currentEnv() fallback would make every future unscoped read
            // resolve back through this same trap, recursing forever.
            if (isEnvProxy(newValue)) {
                return;
            }
            assertNotInsideActiveScope(
                "Reassigning process.env is not allowed in backend functions — it would corrupt the dev server's real environment for every future execution. Use $.Source or a declared Custom Credential instead.",
            );
            sharedState.realEnv = newValue;
        },
    });
}
ensureEnvProxyInstalled();

// /proc/thread-self resolves to /proc/self/task/<tid>, hence the optional /task/<tid> segment.
// Matches any numeric pid, not just process.pid: a parent process (e.g. the shell that launched
// the dev server) inherits the same secrets, and there's no legitimate reason a backend function
// reads any process's environ file during a scoped execution.
const ENVIRON_PATH_RE = /^\/proc\/(self|thread-self|\d+)(\/task\/\d+)?\/environ$/;

// Structural check, not `instanceof Error`: Node's native fs errors can cross a realm boundary
// (e.g. Jest's per-test-file VM sandboxing) where `instanceof Error` is false even though the
// object is a genuine error with a real `.code`, which would otherwise silently misroute a normal
// ENOENT into a fail-closed branch instead of its intended graceful fallback.
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === 'object' && error !== null && 'code' in error;
}

// fs path arguments can legally be a string, a Buffer, or a file:// URL — checking only the string
// case let a Buffer/URL argument to any of the guarded functions bypass the check entirely.
function toPathString(rawPath: unknown): string | undefined {
    if (typeof rawPath === 'string') {
        return rawPath;
    }
    if (Buffer.isBuffer(rawPath)) {
        // Buffer.prototype.toString.call, not rawPath.toString(): a customer-controlled instance can
        // override its own toString to report a benign path while Node's native fs call still reads
        // the real, unmodified bytes.
        return Buffer.prototype.toString.call(rawPath);
    }
    if (rawPath instanceof URL) {
        return fileURLToPath(rawPath);
    }
    if (typeof rawPath === 'number' && process.platform === 'linux') {
        // fs.readFileSync/open and friends also accept an already-open fd in place of a path —
        // /proc/self/fd/<fd> is a Linux-only symlink to whatever that fd actually points at, letting
        // the realpath resolution below see through it the same way it does for a literal symlink
        // path. Only ENOENT falls back to "not path-like"; any other failure (EACCES, ELOOP, ...)
        // is re-thrown rather than treating an unverifiable fd as safe.
        try {
            return fs.readlinkSync(`/proc/self/fd/${rawPath}`);
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                return undefined;
            }
            throw error;
        }
    }
    return undefined;
}

function isEnvironPath(rawPath: unknown): boolean {
    const pathString = toPathString(rawPath);
    if (pathString === undefined) {
        return false;
    }
    // Resolved via realpathSync first, not just normalized: fs.readFileSync and friends follow
    // symlinks transparently, so a symlink pointing at /proc/.../environ would otherwise bypass a
    // literal-string match. Falls back to normalize-only on ENOENT (a nonexistent path can't be
    // /proc/.../environ). Any other realpathSync failure is re-thrown rather than silently treated
    // as a safe path — the real fs call would hit the identical error anyway.
    let resolvedPath: string;
    try {
        resolvedPath = fs.realpathSync(pathString);
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            resolvedPath = nodePath.posix.normalize(pathString);
        } else {
            throw error;
        }
    }
    return ENVIRON_PATH_RE.test(resolvedPath);
}

const ENVIRON_READ_BLOCKED_MESSAGE =
    "Reading /proc/.../environ is not allowed in backend functions — it exposes the dev server's real, unscoped environment. Use $.Source or a declared Custom Credential instead.";

// Per-continuation, like currentEnv() above, so it can't fire for unrelated code running
// concurrently on a different, unscoped continuation. A pure predicate (rather than throwing
// itself) so it can also serve as makeGuardWrapper's shouldBlock. extractFdNumber unwraps an
// already-open FileHandle to the same numeric fd toPathString() resolves via /proc/self/fd, so a
// FileHandle opened against /proc/.../environ before the scope is caught the same way.
function isBlockedEnvironPath(rawPath: unknown): boolean {
    // Short-circuits before touching rawPath at all when no scope is active — extractFdNumber reads
    // a real FileHandle's native .fd getter, which callers outside any scope must never trigger.
    if (sharedState.scopedEnvContext.getStore() === undefined) {
        return false;
    }
    const fdNumber = extractFdNumber(rawPath);
    return isEnvironPath(fdNumber);
}

function throwIfBlockedEnvironPath(rawPath: unknown): void {
    if (isBlockedEnvironPath(rawPath)) {
        throw new Error(ENVIRON_READ_BLOCKED_MESSAGE);
    }
}

// A FileHandle exposes its underlying fd as a plain number via its own .fd property.
function extractFdNumber(fdValue: unknown): unknown {
    if (typeof fdValue === 'object' && fdValue !== null && 'fd' in fdValue) {
        return fdValue.fd;
    }
    return fdValue;
}

// createReadStream/ReadStream's options.fd (a raw fd number, or a FileHandle whose own .fd is one)
// makes Node read from that fd directly, ignoring the leading path argument — a plain
// throwIfBlockedEnvironPath(rawPath) would never see the real target. Returns a safe options
// object rather than the caller's own: options.fd could be an accessor whose getter returns a
// harmless value to this check and a different, real target to Node's own later read.
function guardEnvironPathOrFdOption(rawPath: unknown, options: unknown): unknown {
    throwIfBlockedEnvironPath(rawPath);
    if (typeof options !== 'object' || options === null || !('fd' in options)) {
        return options;
    }
    const fdValue = options.fd;
    const fdNumber = extractFdNumber(fdValue);
    throwIfBlockedEnvironPath(fdNumber);
    return { ...options, fd: fdValue };
}

// Every guarded fs entry point below except createReadStream takes only a leading path argument —
// wraps that shared shape once via the same makeGuardWrapper network-guard.ts uses, with
// isBlockedEnvironPath as an argument-dependent shouldBlock. Only for genuinely synchronous APIs,
// where a guard failure throwing synchronously matches their real Node contract.
function wrapGuardedFsFn<T extends (...args: never[]) => unknown>(real: T): T {
    return makeGuardWrapper(
        () => real,
        (rawPath) => isBlockedEnvironPath(rawPath),
        ENVIRON_READ_BLOCKED_MESSAGE,
        'throw',
    );
}

// fs.promises.* functions must reject rather than throw synchronously on a guard failure, matching
// their real Promise-returning contract.
function wrapGuardedAsyncFsFn<T extends (...args: never[]) => Promise<unknown>>(real: T): T {
    return makeGuardWrapper(
        () => real,
        (rawPath) => isBlockedEnvironPath(rawPath),
        ENVIRON_READ_BLOCKED_MESSAGE,
        'reject',
    );
}

// fs.readFile/open/copyFile/cp report failure via an error-first callback, never a synchronous
// throw — routing them through wrapGuardedFsFn's 'throw' mode would violate that contract for a
// caller that (correctly, per their real signature) never wraps the call itself in a try/catch.
function wrapGuardedCallbackFsFn<T extends (...args: never[]) => unknown>(real: T): T {
    return makeGuardCallbackWrapper(
        () => real,
        (rawPath) => isBlockedEnvironPath(rawPath),
        ENVIRON_READ_BLOCKED_MESSAGE,
    );
}

// createReadStream is the one guarded entry point whose second (options) argument can itself carry
// the real read target via options.fd, bypassing whatever the leading path argument says — every
// other function this file guards only ever reads from its own leading path argument.
function wrapGuardedStreamFn<T extends (...args: never[]) => unknown>(real: T): T {
    const wrapped = (...args: Parameters<T>): ReturnType<T> => {
        const safeOptions = guardEnvironPathOrFdOption(args[0], args[1]);
        const safeArgs = [args[0], safeOptions] as Parameters<T>;
        return real(...safeArgs) as ReturnType<T>;
    };
    return wrapped as T;
}

// open/openSync/promises.open are separate entry points that map a path to a file descriptor
// without going through readFile*, so they need the same guard.
fs.readFileSync = wrapGuardedFsFn(fs.readFileSync);
fs.readFile = wrapGuardedCallbackFsFn(fs.readFile);
fs.promises.readFile = wrapGuardedAsyncFsFn(fs.promises.readFile);
fs.createReadStream = wrapGuardedStreamFn(fs.createReadStream);
fs.openSync = wrapGuardedFsFn(fs.openSync);
fs.open = wrapGuardedCallbackFsFn(fs.open);
fs.promises.open = wrapGuardedAsyncFsFn(fs.promises.open);

// copyFileSync/copyFile/promises.copyFile/cpSync/promises.cp read the source file's bytes through
// a distinct native binding that never calls through readFile*/open* above — an uncovered path that
// could otherwise copy /proc/.../environ to an ordinary, unguarded file and read it back from there.
fs.copyFileSync = wrapGuardedFsFn(fs.copyFileSync);
fs.copyFile = wrapGuardedCallbackFsFn(fs.copyFile);
fs.promises.copyFile = wrapGuardedAsyncFsFn(fs.promises.copyFile);
fs.cpSync = wrapGuardedFsFn(fs.cpSync);
fs.cp = wrapGuardedCallbackFsFn(fs.cp);
fs.promises.cp = wrapGuardedAsyncFsFn(fs.promises.cp);

// createReadStream's own wrap above only covers that factory function — Node also exports the
// ReadStream class it constructs internally, and `new fs.ReadStream(path)` never calls through
// createReadStream at all. @types/node declares no explicit constructor for ReadStream (it inherits
// Readable's), so a subclass can't be typed against its real (path, options) signature — a Proxy's
// construct trap guards the same entry point without needing that signature at all. `new Proxy<T>`
// is itself typed to return T given a T target, so no cast is needed on the assignment either.
fs.ReadStream = new Proxy(fs.ReadStream, {
    construct(target, args, newTarget) {
        const safeOptions = guardEnvironPathOrFdOption(args[0], args[1]);
        return Reflect.construct(target, [args[0], safeOptions], newTarget);
    },
});

// @types/node doesn't declare excludeEnv yet. It's real, but only wired up to the native report
// generator from Node v22.13.0 — CI pins Node 20.19.4, where setting it is a no-op. Kept anyway:
// on versions that support it, it also redacts reports Node generates on its own via
// --report-on-fatalerror/--report-on-signal, which the getReport()/writeReport() wraps below can't
// reach since no JS call happens for those. Augmented globally so every consumer shares one
// canonical type instead of independently-typed `as unknown as` casts.
declare global {
    namespace NodeJS {
        interface ProcessReport {
            excludeEnv?: boolean;
        }
    }
}
const processReport = process.report;

// excludeEnv has its own native setter on Node >=22.13.0, but that setter has no concept of "a
// customer function's own scope," so nothing stops one flipping it back off with
// `process.report.excludeEnv = false` from inside its own scope, silently disarming the
// protection runWithScopedEnv just armed. Guarded the same way process.env is: redefined as an
// accessor whose setter only rejects a reassignment made from inside an active scope. Wraps
// Node's own native get/set (when present) rather than a plain JS variable: the native
// report-generator triggered by --report-on-fatalerror/--report-on-signal reads Node's real
// internal flag directly, not this property, so a plain-variable shadow would have zero effect on
// those non-JS-triggered reports. Installed only once, tracked via
// sharedState.excludeEnvGuardInstalled rather than a descriptor check, since Node's own native
// accessor already has a getter and this file's top-level code re-runs on every evaluation.
function guardedExcludeEnvSetter(applyNewValue: (newValue: boolean | undefined) => void) {
    return (newValue: boolean | undefined) => {
        assertNotInsideActiveScope(
            "Reassigning process.report.excludeEnv is not allowed in backend functions — it would let a backend function's own diagnostic report include the dev server's real environment. This is armed automatically for the duration of the function's execution.",
        );
        if (sharedState.activeScopeCount > 0) {
            // An unrelated caller writing from outside any scope while a DIFFERENT scope is still
            // active elsewhere — applying it immediately would disarm redaction out from under
            // that scope, so it's deferred to take effect once the active scope's own cleanup runs.
            sharedState.savedExcludeEnv = newValue;
            return;
        }
        applyNewValue(newValue);
    };
}

if (!sharedState.excludeEnvGuardInstalled) {
    const nativeExcludeEnvDescriptor = Object.getOwnPropertyDescriptor(processReport, 'excludeEnv');
    let excludeEnvGet: () => boolean | undefined;
    let applyExcludeEnvValue: (newValue: boolean | undefined) => void;
    if (nativeExcludeEnvDescriptor?.get && nativeExcludeEnvDescriptor.set) {
        excludeEnvGet = nativeExcludeEnvDescriptor.get.bind(processReport);
        applyExcludeEnvValue = nativeExcludeEnvDescriptor.set.bind(processReport);
    } else {
        // Node <22.13.0 (CI pins 20.19.4): no native accessor exists yet, so there's no real flag
        // to keep in sync — a plain shadow variable is enough to guard reassignment, even though
        // reading or writing it has no effect on report generation on this version either way.
        let excludeEnvValue: boolean | undefined = processReport.excludeEnv;
        excludeEnvGet = () => excludeEnvValue;
        applyExcludeEnvValue = (newValue) => {
            excludeEnvValue = newValue;
        };
    }
    sharedState.applyExcludeEnvValue = applyExcludeEnvValue;
    Object.defineProperty(processReport, 'excludeEnv', {
        configurable: false,
        enumerable: true,
        get: excludeEnvGet,
        set: guardedExcludeEnvSetter(applyExcludeEnvValue),
    });
    sharedState.excludeEnvGuardInstalled = true;
}

type ReportLike = Record<string, unknown> & { environmentVariables?: unknown };

// process.report.getReport()'s declared return type is a bare `object`, carrying no shape
// information — this predicate narrows it without an `as` cast.
function hasEnvironmentVariables(report: object): report is ReportLike {
    return 'environmentVariables' in report;
}

// Preserves the original's exact (possibly-overloaded) type on the returned wrapper, the same
// reasoning as wrapGuardedFsFn/wrapGuardedAsyncFsFn above, so getReport/writeReport below can
// reassign with no cast — `implementation` receives the original as its first argument rather than
// closing over it, since each wrap's own logic differs and can't share one generic body.
function wrapReportFn<T extends (...args: never[]) => unknown>(
    original: T,
    implementation: (original: T, ...args: Parameters<T>) => ReturnType<T>,
): T {
    const wrapped = (...args: Parameters<T>): ReturnType<T> => implementation(original, ...args);
    return wrapped as T;
}

// Strips environmentVariables at the JS level so a customer function's own getReport()/
// writeReport() call is redacted on every supported Node version, not just where excludeEnv is
// wired up. writeReport() lets Node handle filename generation/defaults as normal, then
// post-processes the file it actually wrote rather than reimplementing its naming convention.
const originalGetReport = process.report.getReport.bind(process.report);
process.report.getReport = wrapReportFn(originalGetReport, (original, ...args) => {
    const report = original(...args);
    if (sharedState.activeScopeCount > 0 && hasEnvironmentVariables(report)) {
        delete report.environmentVariables;
    }
    return report;
});

const originalWriteReport = process.report.writeReport.bind(process.report);
process.report.writeReport = wrapReportFn(originalWriteReport, (original, ...args) => {
    const filename = original(...args);
    if (sharedState.activeScopeCount > 0) {
        const rawReport = fs.readFileSync(filename, 'utf8');
        const report: ReportLike = JSON.parse(rawReport);
        delete report.environmentVariables;
        const serializedReport = JSON.stringify(report, null, 2);
        fs.writeFileSync(filename, serializedReport);
    }
    return filename;
});

// installGuardedProperty in network-guard.ts only patches the CJS-style default-export object;
// Node keeps ESM named bindings (e.g. `import { readFileSync } from 'node:fs'`) as separate
// references that stay bound to the original native functions otherwise.
syncBuiltinESMExports();

// Shared by runWithScopedEnv's finally and forceResetEnv's own reset, so the two restore paths
// can't drift apart. No separate "armed" flag is needed against a second, already-discharged
// call: the resetEpoch check in runWithScopedEnv's finally means a stale zombie scope can no
// longer reach this function at all once forceResetEnv() has run.
function restoreExcludeEnvIfLastScope(): void {
    if (sharedState.activeScopeCount === 0) {
        // Direct apply, not `processReport.excludeEnv = ...`, matching runWithScopedEnv's own arm
        // step above — this is the framework's own trusted restore, not an outside caller's write.
        sharedState.applyExcludeEnvValue(sharedState.savedExcludeEnv);
        sharedState.savedExcludeEnv = undefined;
    }
}

// Wraps only the customer function's own call in local-execution.ts's runScriptLocally, matching runBlocked's scope exactly.
export async function runWithScopedEnv<T>(
    scopedEnv: Record<string, string>,
    fn: () => Promise<T>,
): Promise<T> {
    ensureEnvProxyInstalled();
    const myResetEpoch = sharedState.resetEpoch;
    sharedState.activeScopeCount += 1;
    if (sharedState.activeScopeCount === 1) {
        // process.report.getReport()/writeReport() read the OS-level environment table directly,
        // bypassing the process.env Proxy — this also sets excludeEnv for the auto-triggered report
        // case on Node versions that support it. Applied directly via
        // sharedState.applyExcludeEnvValue, not the guarded `processReport.excludeEnv =` accessor:
        // activeScopeCount is already incremented by this point, so the guarded setter would defer
        // this call as an outside caller's write instead of actually arming the flag.
        sharedState.savedExcludeEnv = processReport.excludeEnv;
        sharedState.applyExcludeEnvValue(true);
    }
    try {
        return await sharedState.scopedEnvContext.run(scopedEnv, fn);
    } finally {
        // Skipped once forceResetEnv() has bumped resetEpoch since this call started: that means
        // this call's own decrement/restore obligation was already forcibly discharged, and the
        // shared activeScopeCount now belongs to a different, later scope — touching it here would
        // disarm that scope's still-active protection instead of this one's.
        if (sharedState.resetEpoch === myResetEpoch) {
            // Clamped at 0, not a bare decrement, as defense in depth against any other path that
            // might desync the count from the number of genuinely open scopes.
            sharedState.activeScopeCount = Math.max(0, sharedState.activeScopeCount - 1);
            restoreExcludeEnvIfLastScope();
        }
    }
}

// Defensive reset for process.report's reference count only — process.env itself never needs
// forcing back, since scopedEnvContext resolves each continuation independently and a zombie's
// still-open scope was never shared global state to begin with. Called from
// local-execution.ts's abandonExecutionAndRejectWith when a timed-out execution's fn() will never
// settle and so never reach its finally.
export function forceResetEnv(): void {
    if (sharedState.activeScopeCount > 0) {
        sharedState.activeScopeCount = 0;
        // Invalidates every currently-open scope's own pending finally (see resetEpoch's own
        // comment) — each one now finds resetEpoch has moved past its own snapshot and skips
        // touching this state entirely, leaving it exclusively to whatever scope starts next.
        sharedState.resetEpoch += 1;
        restoreExcludeEnvIfLastScope();
    }
}
