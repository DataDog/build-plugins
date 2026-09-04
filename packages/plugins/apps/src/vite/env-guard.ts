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

// Scopes process.env to a from-scratch allowlist during local execution. There's no process
// boundary here to stop customer code from reading the dev server's real environment, including
// its own credentials — production runs each execution in its own Deno subprocess with
// --allow-env, but local execution has no equivalent isolation. This also blocks the
// /proc/.../environ backing-store bypass on Linux, which swapping process.env alone doesn't stop.
//
// Matches network-guard.ts's own framing: no OS sandbox here, so this is JS-level
// defense-in-depth, not a hard security boundary. A native addon reading the real environment via
// libc directly is outside what this file can intercept. So is a callback that escapes its own
// scope's AsyncLocalStorage continuation entirely — a FinalizationRegistry finalizer, for example,
// which Node runs outside any tracked continuation — and reassigns process.env from there. The
// reassignment setter below can only tell that no scope is currently active, which is
// indistinguishable from a legitimate reload happening long after the callback's own scope has
// already concluded. So this doesn't just see stale data: it can adopt attacker-controlled data as
// the new real-environment fallback for every later execution, the same way a plain, untracked
// reassignment could before that setter existed.

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
    return { ...scoped, ...customCredentials };
}

/** Everything a re-evaluation of this file needs to share with every other re-evaluation — see getSharedState()'s own comment for why this can't just be module-level `let`s. */
interface SharedEnvGuardState {
    scopedEnvContext: AsyncLocalStorage<Record<string, string>>;
    realEnv: NodeJS.ProcessEnv;
    activeScopeCount: number;
    savedExcludeEnv: boolean | undefined;
    // Bumped by forceResetEnv(). activeScopeCount is shared by ALL concurrent scopes, not per-call —
    // without this, a zombie scope's own delayed finally (forcibly closed out by forceResetEnv()
    // while still pending) would later apply its decrement/restore against whatever DIFFERENT,
    // still-legitimately-running scope has since claimed that same shared state, disarming excludeEnv
    // protection out from under it. Each runWithScopedEnv call snapshots this at start and skips its
    // own finally's cleanup entirely if it's changed by the time that runs, since forceResetEnv()
    // already discharged this call's obligation on its behalf — the only path that can reach
    // restoreExcludeEnvIfLastScope() with activeScopeCount === 0 is the one call (a real scope's own
    // finally, or forceResetEnv()) that owns the arming from a matching 0→1 transition, so no separate
    // "armed" flag is needed to guard against a second, already-discharged call getting through.
    resetEpoch: number;
    // process.report.excludeEnv already has a native getter/setter of its own (Node validates the
    // assigned value there), so "does it already have an accessor" can't tell our guarded version
    // apart from Node's own stock one — this is the actual install marker, checked instead.
    excludeEnvGuardInstalled: boolean;
    // The raw, unguarded apply function installed below — runWithScopedEnv's own arm/disarm calls
    // this directly instead of assigning through the public `processReport.excludeEnv =` accessor,
    // since that accessor's guardedExcludeEnvSetter now defers a write made while a scope is active
    // (see its own comment) and would otherwise swallow the framework's own trusted arm/disarm calls
    // the exact same way it defers an unrelated caller's.
    applyExcludeEnvValue: (newValue: boolean | undefined) => void;
}

// Keyed on the real `fs` module (not a per-module-instance object), via the same
// getOrCreateShared() helper network-guard.ts's own getSharedContext() uses: this file gets
// evaluated more than once — bundled copies and Jest's per-test-file isolation — and every
// evaluation needs the SAME scopedEnvContext/realEnv/activeScopeCount, not its own separate copy.
// Without this, a second evaluation's runWithScopedEnv would populate its own private
// AsyncLocalStorage that the first evaluation's already-installed Proxy (bound to the first
// evaluation's own closures) never consults, so customer code would read the real, unscoped
// environment through that Proxy with no error and no scoping at all.
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
        // Not forwardToCurrentEnv(Reflect.set): a plain `process.env[key] = value` from outside any
        // scope passes the Proxy itself as `receiver`. Per OrdinarySet, `receiver !== target` on an
        // existing writable data property falls back to `receiver.[[DefineOwnProperty]]` with a
        // PARTIAL descriptor, recursing into the defineProperty trap below with an incomplete
        // descriptor that Node's native process.env binding rejects outright. Calling Reflect.set
        // with only 2 arguments defaults receiver to `env` itself, which — for both currentEnv()
        // outcomes (the real env, or a plain scoped object) — is a genuine own property, so this
        // resolves as a direct set instead of ever reaching that fallback path.
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
        // Can't forward to currentEnv() like the other traps: the Proxy invariants require that a
        // `preventExtensions` trap returning `true` only be honored if `target` itself (the real env
        // object, always passed in as `target` regardless of what currentEnv() resolves to) is
        // ALSO already non-extensible — so routing this to the scoped object would either silently
        // do nothing (the real env stays extensible, engine throws on the next ownKeys call as the
        // target/trap-result mismatch is detected) or require actually freezing the real env to
        // satisfy the invariant, which would break it process-wide. Refusing outright is the only
        // option that can't leak real-env state or brick the proxy either way. No isExtensible trap
        // is needed alongside it: the default (untrapped) behavior already forwards to `target`,
        // which stays truthfully extensible since preventExtensions never actually mutates it.
        preventExtensions: () => false,
    });
    // process.env is defined as an accessor property, not left as the plain, freely-reassignable
    // data property it started as — a bare `process.env = X` replaces `process`'s own `env`
    // property outright rather than going through any trap on the object those traps guard, so
    // without this, a customer function could wholesale-replace process.env from inside its own
    // scope with no error, and the NEXT runWithScopedEnv call's ensureEnvProxyInstalled() would then
    // silently adopt that customer-controlled object as the new realEnv fallback — corrupting every
    // later, unrelated execution's own safe-allowlisted view with attacker-supplied data.
    // configurable: false so nothing can later strip this accessor back to a plain data property.
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

// /proc/thread-self is a symlink to /proc/self/task/<tid>, so its realpath-resolved form carries
// an extra /task/<tid> segment that /proc/self and /proc/<pid> never do. Matches any numeric pid,
// not just process.pid: the dev server's own parent (commonly the shell or package manager that
// launched it) inherits the same secrets this guard hides, and its /proc entry is just as readable
// as any other accessible pid's — there's no legitimate reason a backend function reads ANY
// process's real environ file during a scoped execution, so blocking the whole family is both
// simpler and more robust than enumerating which specific pids to special-case.
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
        return rawPath.toString();
    }
    if (rawPath instanceof URL) {
        return fileURLToPath(rawPath);
    }
    if (typeof rawPath === 'number' && process.platform === 'linux') {
        // fs.readFileSync/open and friends also accept an already-open fd in place of a path —
        // /proc/self/fd/<fd> is a Linux-only symlink to whatever that fd actually points at, which
        // lets the realpath-based resolution below see through to the real target the same way it
        // already does for a symlink passed as a literal path. Off Linux there's no portable way to
        // recover a fd's path at all, so a numeric fd is simply never path-like enough to check —
        // matching this file's existing environ-guard tests, which are Linux-only for the same
        // /proc-specific reason. Only ENOENT (the fd genuinely doesn't exist) falls back to "not
        // path-like" — any other failure (EACCES, ELOOP, ...) means the real target can't be
        // verified, so it's re-thrown rather than silently treating an unverifiable fd as safe,
        // matching isEnvironPath's identical fail-closed handling of realpathSync below.
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
    // Resolved via realpathSync first, not just normalized: a symlink pointing at /proc/.../environ
    // has its own, unrelated literal path, so matching only the (even normalized) literal string
    // would let a backend function read the real environment straight through a symlink it created
    // itself — fs.readFileSync and friends follow symlinks transparently. Falls back to
    // normalize-only when the path doesn't exist yet (ENOENT, e.g. a new file being created) — a
    // nonexistent path can't be /proc/.../environ anyway. Any other realpathSync failure (EACCES,
    // ELOOP, ...) means the real target can't be verified, so it's re-thrown rather than silently
    // falling through to an unresolved literal match a symlink could bypass — the caller (the real
    // fs function about to run) would hit the identical error anyway, so this only changes WHEN it
    // surfaces, not whether the read is denied, and avoids masking an unrelated permission/loop error
    // behind a misleading "environ" message.
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

// Per-continuation, like currentEnv() above: only the specific continuation currently inside its
// own scope pays this check, so it can't fire for unrelated code (Vite's own internals, a sibling
// execution) running concurrently on a different continuation that isn't scoped at all. A pure
// predicate (rather than throwing itself) so it can also serve as makeGuardWrapper's shouldBlock.
// fs.promises.readFile also accepts an already-open FileHandle in place of a path — extractFdNumber
// unwraps it to the same numeric fd toPathString() already resolves via /proc/self/fd for a plain
// numeric-fd argument, so a FileHandle opened against /proc/.../environ before the scope is caught
// the same way. A no-op for every other argument shape (string/Buffer/URL/number), none of which have their own `.fd` property.
function isBlockedEnvironPath(rawPath: unknown): boolean {
    return (
        sharedState.scopedEnvContext.getStore() !== undefined &&
        isEnvironPath(extractFdNumber(rawPath))
    );
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
// makes Node read from that fd directly and ignore the leading path argument entirely — a plain
// throwIfBlockedEnvironPath(rawPath) would never see the real target when it's passed this way instead.
// Returns a safe options object to actually pass to the real call in place of the caller's own:
// options.fd could be an accessor property whose getter returns a harmless value the one time this
// check reads it and a different, real target the next time Node's own implementation separately
// reads the same property — captured into a plain data property here, options.fd can only ever be
// read as the exact value that was already checked.
function guardEnvironPathOrFdOption(rawPath: unknown, options: unknown): unknown {
    throwIfBlockedEnvironPath(rawPath);
    if (typeof options !== 'object' || options === null || !('fd' in options)) {
        return options;
    }
    const fdValue = options.fd;
    throwIfBlockedEnvironPath(extractFdNumber(fdValue));
    return { ...options, fd: fdValue };
}

// Every guarded fs entry point below except createReadStream takes only a leading path argument
// and forwards the rest unchanged — wraps that shared shape once instead of repeating it per
// function, via the same makeGuardWrapper network-guard.ts uses, with isBlockedEnvironPath as the
// argument-dependent shouldBlock (network-guard.ts's own uses are all argument-independent). Only
// for genuinely synchronous APIs (readFileSync, openSync, and friends) — a guard failure throwing
// synchronously matches their real Node contract.
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
// generator from Node v22.13.0 — CI pins Node 20.19.4, where setting it is a silent no-op, so it
// alone doesn't close this gap on every Node version this repo supports. Kept anyway: on versions
// that do support it, it also covers reports Node generates on its own via --report-on-fatalerror/
// --report-on-signal, which the getReport()/writeReport() wraps below can't reach since no JS call
// happens for those. Augmented globally (rather than cast with `as unknown as`) so every consumer,
// including this file's own test, shares one canonical type instead of independently-typed casts.
declare global {
    namespace NodeJS {
        interface ProcessReport {
            excludeEnv?: boolean;
        }
    }
}
const processReport = process.report;

// excludeEnv already has its own native getter/setter on Node >=22.13.0 (Node validates the assigned
// value there) — but that setter has no concept of "a customer function's own scope," so nothing
// stops one from flipping it back off with `process.report.excludeEnv = false` from inside its own
// scope, silently disarming the protection runWithScopedEnv below just armed for that same scope.
// Guarded the same way process.env is: redefined as an accessor whose setter only rejects a
// reassignment made BY code running inside its own active scope, so
// runWithScopedEnv's/restoreExcludeEnvIfLastScope's own arm/disarm (both always run from outside any
// scope — see runWithScopedEnv's own comment) pass through untouched. Wraps Node's own native
// get/set (when present) rather than replacing them with a plain JS variable: the native
// report-generator triggered by --report-on-fatalerror/--report-on-signal reads its own internal
// flag directly, not this property, so a plain-variable shadow would read back whatever value was
// last written yet have zero effect on what those native, non-JS-triggered reports actually contain
// — wrapping keeps that real, underlying flag in sync, and picks Node's own value-validation back up
// as a side effect. Installed only once (tracked via sharedState.excludeEnvGuardInstalled, not a
// descriptor check — Node's own native accessor already has a getter, so "does it have one" can't
// tell that apart from our own already being installed): this file's top-level code re-runs on every
// evaluation (bundled copies, Jest's per-test-file isolation), and process.report is a true
// singleton, not the getSharedState()-style per-installation object above — a second
// Object.defineProperty on an already-configurable:false accessor would throw.
function guardedExcludeEnvSetter(applyNewValue: (newValue: boolean | undefined) => void) {
    return (newValue: boolean | undefined) => {
        assertNotInsideActiveScope(
            "Reassigning process.report.excludeEnv is not allowed in backend functions — it would let a backend function's own diagnostic report include the dev server's real environment. This is armed automatically for the duration of the function's execution.",
        );
        if (sharedState.activeScopeCount > 0) {
            // The customer itself can't reach this branch (assertNotInsideActiveScope already
            // rejected it above) — this is an unrelated caller writing from outside any scope while
            // a DIFFERENT scope is still active elsewhere. Applying it immediately would disarm
            // redaction out from under that still-running scope; storing it as the value to restore
            // instead means it takes effect once the active scope's own cleanup runs, and that
            // cleanup no longer clobbers it with the pre-scope original.
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
// can't drift apart. No separate "armed" flag guards this against a second, already-discharged
// call: the resetEpoch check in runWithScopedEnv's finally (see its own comment) means a stale
// zombie scope can no longer reach this function at all once forceResetEnv() has run, rather than
// merely being neutralized after arriving — so by the time anything calls this with
// activeScopeCount === 0, it's always the one call that owns a matching 0→1 arm to restore from.
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
        // bypassing the process.env Proxy above entirely — the wraps above cover JS-triggered calls
        // on every Node version; this also sets excludeEnv for the auto-triggered case on versions
        // that support it (see the wraps' own comment for why both exist). Applied directly via
        // sharedState.applyExcludeEnvValue, not `processReport.excludeEnv = true`: activeScopeCount
        // is already incremented by this point, so going through the guarded property's own setter
        // would defer this exact call as though it were an unrelated outside caller's write (see
        // guardedExcludeEnvSetter's own comment) instead of actually arming the flag.
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
// local-execution.ts's abandonExecutionAndRejectWith when a timed-out execution's own
// runWithScopedEnv call will never reach its finally (its fn() never settles), and from
// env-guard.test.ts's own afterEach as the same hard backstop for a test that left
// activeScopeCount incremented the same way.
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
