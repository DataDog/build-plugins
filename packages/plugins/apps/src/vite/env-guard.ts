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

// Captured at module load — before any customer code runs — so a backend function can't replace
// fs.realpathSync/readlinkSync with a benign-path stub and read /proc/self/environ through this
// file's own already-wrapped fs.readFileSync, whose forged-path check would otherwise consult the
// tampered, live fs methods instead of these frozen references.
const nativeRealpathSync = fs.realpathSync;
const nativeReadlinkSync = fs.readlinkSync;

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

/**
 * Shared across every re-evaluation of this file (see getSharedState()). Every member is a
 * function, not a data field, since this object is reachable via any `require('fs')` — a raw
 * `realEnv` field would leak the real environment, and a raw `AsyncLocalStorage` would let a
 * caller kill scope detection process-wide via `.disable()`. Each function re-checks scope itself.
 */
interface EnvGuardSharedState {
    getCurrentEnv(): Record<string, string> | NodeJS.ProcessEnv;
    isInsideScope(): boolean;
    setRealEnvIfOutsideScope(newValue: NodeJS.ProcessEnv): void;
    restoreRealEnvFromHistory(): void;
    runInScope<T>(scopedEnv: Record<string, string>, fn: () => Promise<T>): Promise<T>;
    // Symbol() (not Symbol.for), so the token is never attached as a discoverable property anywhere
    // — Object.getOwnPropertySymbols can't reveal it, and it can't be reconstructed from a string.
    // Only the exact token armScope() returned can end the scope it identifies, closing off the
    // "call the shared decrement directly enough times to zero the count early" bypass a raw counter
    // would allow any caller with `require('fs')` to trigger.
    armScope(): symbol;
    disarmScope(token: symbol): void;
    forceResetAllScopes(): void;
    getExcludeEnv(): boolean | undefined;
}

// Keyed on the real `fs` module, via the same getOrCreateShared() helper network-guard.ts uses:
// this file gets evaluated more than once (bundled copies, Jest's per-test-file isolation), and
// every evaluation must share the same scope/env/count state or a later evaluation's Proxy would
// never consult the storage an earlier evaluation's scope populates. The factory runs exactly once
// across every evaluation (see getOrCreateShared), so anything done here — including installing
// process.report.excludeEnv's accessor below — is inherently a run-once side effect, with no
// separate "already installed" marker needed.
function getSharedState(): EnvGuardSharedState {
    return getOrCreateShared(fs, '@dd/apps-plugin/env-guard shared-state', () => {
        const scopedEnvContext = new AsyncLocalStorage<Record<string, string>>();
        // Bound here, at first-ever creation — before any customer code has had a chance to run —
        // so a later `AsyncLocalStorage.prototype.getStore = () => undefined` from inside a backend
        // function can't make every scoped lookup fall through to the real environment.
        const nativeGetStore = AsyncLocalStorage.prototype.getStore.bind(scopedEnvContext);
        let realEnv: NodeJS.ProcessEnv = process.env;
        // Pushed before each non-proxy reassignment, popped when the proxy itself is assigned back
        // — implements `const saved = process.env; ...; process.env = saved;` correctly for
        // arbitrarily nested save/restore, not just a no-op that leaves realEnv stuck mid-swap.
        const realEnvHistory: NodeJS.ProcessEnv[] = [];
        const activeScopeTokens = new Set<symbol>();
        let savedExcludeEnv: boolean | undefined;

        function currentEnv(): Record<string, string> | NodeJS.ProcessEnv {
            return nativeGetStore() ?? realEnv;
        }

        // process.report.excludeEnv already has a native getter/setter on Node >=22.13.0 — this
        // wraps it so an armed scope can't be disarmed with `process.report.excludeEnv = false`
        // from inside itself. On older Node (CI pins 20.19.4) there's no real accessor to wrap, but
        // a plain shadow variable still keeps read/write consistent even though it has no effect on
        // report generation on that version either way.
        const nativeExcludeEnvDescriptor = Object.getOwnPropertyDescriptor(
            process.report,
            'excludeEnv',
        );
        let getExcludeEnv: () => boolean | undefined;
        let applyExcludeEnvValue: (newValue: boolean | undefined) => void;
        if (nativeExcludeEnvDescriptor?.get && nativeExcludeEnvDescriptor.set) {
            getExcludeEnv = nativeExcludeEnvDescriptor.get.bind(process.report);
            applyExcludeEnvValue = nativeExcludeEnvDescriptor.set.bind(process.report);
        } else {
            let excludeEnvValue: boolean | undefined = process.report.excludeEnv;
            getExcludeEnv = () => excludeEnvValue;
            applyExcludeEnvValue = (newValue) => {
                excludeEnvValue = newValue;
            };
        }

        function restoreExcludeEnvIfLastScope(): void {
            if (activeScopeTokens.size === 0) {
                applyExcludeEnvValue(savedExcludeEnv);
                savedExcludeEnv = undefined;
            }
        }

        Object.defineProperty(process.report, 'excludeEnv', {
            configurable: false,
            enumerable: true,
            get: getExcludeEnv,
            set: (newValue: boolean | undefined) => {
                if (nativeGetStore() !== undefined) {
                    throw new Error(
                        "Reassigning process.report.excludeEnv is not allowed in backend functions — it would let a backend function's own diagnostic report include the dev server's real environment. This is armed automatically for the duration of the function's execution.",
                    );
                }
                if (activeScopeTokens.size > 0) {
                    // An unrelated caller writing from outside any scope while a DIFFERENT scope is
                    // still active elsewhere — applying it immediately would disarm redaction out
                    // from under that scope, so it's deferred until the active scope's own cleanup.
                    savedExcludeEnv = newValue;
                    return;
                }
                applyExcludeEnvValue(newValue);
            },
        });

        return {
            getCurrentEnv: currentEnv,
            isInsideScope: () => nativeGetStore() !== undefined,
            setRealEnvIfOutsideScope: (newValue) => {
                if (nativeGetStore() !== undefined) {
                    throw new Error(
                        "Reassigning process.env is not allowed in backend functions — it would corrupt the dev server's real environment for every future execution. Use $.Source or a declared Custom Credential instead.",
                    );
                }
                realEnvHistory.push(realEnv);
                realEnv = newValue;
            },
            restoreRealEnvFromHistory: () => {
                if (realEnvHistory.length > 0) {
                    realEnv = realEnvHistory.pop() as NodeJS.ProcessEnv;
                }
            },
            runInScope: (scopedEnv, fn) => scopedEnvContext.run(scopedEnv, fn),
            armScope: () => {
                const token = Symbol('env-guard scope token');
                if (activeScopeTokens.size === 0) {
                    savedExcludeEnv = getExcludeEnv();
                    applyExcludeEnvValue(true);
                }
                activeScopeTokens.add(token);
                return token;
            },
            disarmScope: (token) => {
                // Set.delete() returns false when the token is already gone — e.g. forceResetEnv()
                // cleared every token first — meaning this scope's decrement/restore obligation was
                // already forcibly discharged, and the shared state now belongs to a later scope.
                if (activeScopeTokens.delete(token)) {
                    restoreExcludeEnvIfLastScope();
                }
            },
            forceResetAllScopes: () => {
                if (activeScopeTokens.size > 0) {
                    activeScopeTokens.clear();
                    restoreExcludeEnvIfLastScope();
                }
            },
            getExcludeEnv,
        };
    });
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

// Shared by every Proxy trap below that does nothing but forward to sharedState.getCurrentEnv()
// with no extra logic of its own — get/has are hand-written instead, since both also
// short-circuit ENV_PROXY_MARKER.
function forwardToCurrentEnv<Args extends unknown[], R>(
    reflectFn: (env: Record<string, string> | NodeJS.ProcessEnv, ...args: Args) => R,
): (_target: NodeJS.ProcessEnv, ...args: Args) => R {
    return (_target, ...args) => {
        const env = sharedState.getCurrentEnv();
        return reflectFn(env, ...args);
    };
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
    const proxy = new Proxy(process.env, {
        get: (_target, prop, receiver) => {
            if (prop === ENV_PROXY_MARKER) {
                return true;
            }
            const env = sharedState.getCurrentEnv();
            return Reflect.get(env, prop, receiver);
        },
        // Not forwardToCurrentEnv(Reflect.set): a plain `process.env[key] = value` passes the Proxy
        // itself as `receiver`, which for an existing writable property falls back to a PARTIAL
        // descriptor that Node's native process.env binding rejects outright. Omitting `receiver`
        // from Reflect.set defaults it to `env` itself, resolving as a direct set instead.
        set: (_target, prop, value) => Reflect.set(sharedState.getCurrentEnv(), prop, value),
        has: (_target, prop) => {
            const env = sharedState.getCurrentEnv();
            return prop === ENV_PROXY_MARKER || Reflect.has(env, prop);
        },
        deleteProperty: forwardToCurrentEnv(Reflect.deleteProperty),
        ownKeys: forwardToCurrentEnv(Reflect.ownKeys),
        getOwnPropertyDescriptor: forwardToCurrentEnv(Reflect.getOwnPropertyDescriptor),
        defineProperty: forwardToCurrentEnv(Reflect.defineProperty),
        // Without this trap, Object.setPrototypeOf(process.env, ...) defaults to forwarding to
        // `target` (the real, unscoped env object) and silently poisons its prototype chain
        // permanently, even when called from inside a scope — since getCurrentEnv() only affects
        // property access, not the object identity a prototype mutation lands on.
        setPrototypeOf: forwardToCurrentEnv(Reflect.setPrototypeOf),
        // Paired with setPrototypeOf above: without this trap, a customer function that sets a
        // scoped prototype and immediately reads it back would see `target`'s (the real env's)
        // untouched prototype instead of the one it just set on the scoped view.
        getPrototypeOf: forwardToCurrentEnv(Reflect.getPrototypeOf),
        // Can't forward to getCurrentEnv(): the Proxy invariants only honor a `preventExtensions` trap
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
            // Self-assignment: something captured process.env (getting this same proxy back, e.g.
            // a test's own `const saved = process.env; ...; process.env = saved;` restore pattern)
            // and wrote it back. Restoring the pre-swap value from history — rather than a no-op —
            // makes this correct; adopting the proxy itself as the real env instead would make every
            // future unscoped read recurse back through this same trap forever.
            if (isEnvProxy(newValue)) {
                sharedState.restoreRealEnvFromHistory();
                return;
            }
            sharedState.setRealEnvIfOutsideScope(newValue);
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
            return nativeReadlinkSync(`/proc/self/fd/${rawPath}`);
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
        resolvedPath = nativeRealpathSync(pathString);
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

// Per-continuation, like getCurrentEnv() above, so it can't fire for unrelated code running
// concurrently on a different, unscoped continuation. A pure predicate (rather than throwing
// itself) so it can also serve as makeGuardWrapper's shouldBlock. extractFdNumber unwraps an
// already-open FileHandle to the same numeric fd toPathString() resolves via /proc/self/fd, so a
// FileHandle opened against /proc/.../environ before the scope is caught the same way.
function isBlockedEnvironPath(rawPath: unknown): boolean {
    // Short-circuits before touching rawPath at all when no scope is active — extractFdNumber reads
    // a real FileHandle's native .fd getter, which callers outside any scope must never trigger.
    if (!sharedState.isInsideScope()) {
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
    if (sharedState.isInsideScope() && hasEnvironmentVariables(report)) {
        delete report.environmentVariables;
    }
    return report;
});

const originalWriteReport = process.report.writeReport.bind(process.report);
process.report.writeReport = wrapReportFn(originalWriteReport, (original, ...args) => {
    if (sharedState.isInsideScope()) {
        // writeReport(fileName?, err?) also accepts writeReport(err?) with no fileName at all —
        // only a string first argument is ever a caller-chosen destination, so this branch is
        // skipped (falling through to Node's own write below) when none was given.
        const fileNameArg = args[0];
        if (typeof fileNameArg === 'string') {
            // Builds the redacted report itself and writes it directly, rather than letting Node
            // persist the real report first and rewriting it after — that would leave unredacted
            // content on disk if anything between the two writes throws. Cast: TS collapses the
            // bound writeReport's overloads to `(err?: Error)`, so the real err arg needs restating.
            const errArg = (args as unknown as [string?, Error?])[1];
            const report = originalGetReport(errArg) as ReportLike;
            delete report.environmentVariables;
            fs.writeFileSync(fileNameArg, JSON.stringify(report, null, 2));
            return fileNameArg;
        }
    }
    const filename = original(...args);
    if (sharedState.isInsideScope()) {
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

export interface EnvScopeHandle {
    // Discharges this specific call's own token, safe to call even while a different scope is
    // still active — unlike forceResetEnv(), it never touches a token it doesn't own.
    abandon(): void;
}

// Wraps only the customer function's own call in local-execution.ts's runScriptLocally, matching
// runBlocked's scope exactly. `onScopeStarted`, if given, is invoked synchronously with a handle
// scoped to *this* call, for a caller whose own timeout might fire while `fn` is still pending.
export async function runWithScopedEnv<T>(
    scopedEnv: Record<string, string>,
    fn: () => Promise<T>,
    onScopeStarted?: (handle: EnvScopeHandle) => void,
): Promise<T> {
    ensureEnvProxyInstalled();
    const token = sharedState.armScope();
    onScopeStarted?.({ abandon: () => sharedState.disarmScope(token) });
    try {
        return await sharedState.runInScope(scopedEnv, fn);
    } finally {
        sharedState.disarmScope(token);
    }
}

// Test-only escape hatch for resetting shared module state between tests — unconditional, unlike
// EnvScopeHandle.abandon(), since a test fully controls when scopes start and end. Production code
// discharges a specific hung scope via that handle instead, since this would otherwise also disarm
// a different, still-active execution's own scope.
export function forceResetEnv(): void {
    sharedState.forceResetAllScopes();
}
