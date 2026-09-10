// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global NodeJS, Proxy */

import fs from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { syncBuiltinESMExports } from 'node:module';
import nodePath from 'path';
import { fileURLToPath } from 'url';

import { invokeCallbackArg, makeGuardCallbackWrapper, makeGuardWrapper } from './guarded-wrapper';
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

// customCredentials comes from custom-credentials-resolver.ts's resolveCustomCredentials — a
// developer-maintained local file, empty by default.
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
    getCachedNativeFdGetter(): (() => number) | undefined;
    setCachedNativeFdGetterOnce(getter: (() => number) | undefined): void;
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
        // Captured once, from the first real FileHandle fs.promises.open() ever returns — the same
        // reference read()/readFile()/readv()'s own guards use, shared here so extractFdNumber's
        // cross-check for fs.promises.readFile(handle) and createReadStream's options.fd survives
        // this file's own re-evaluation (bundled copies, Jest's per-test-file isolation).
        let cachedNativeFdGetter: (() => number) | undefined;
        let nativeFdGetterCaptured = false;

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
                    // from under that scope, so it's deferred instead. Applied and immediately
                    // reverted here (rather than just stashed) so Node's own setter validation still
                    // runs now — an invalid value throws here instead of surfacing later,
                    // misattributed to whichever scope's cleanup happens to apply it.
                    const currentValue = getExcludeEnv();
                    applyExcludeEnvValue(newValue);
                    applyExcludeEnvValue(currentValue);
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
                if (typeof newValue !== 'object' || newValue === null) {
                    // isEnvProxy() only ever returns true for an object, so without this check a
                    // primitive assignment (process.env = 1, process.env = null) would store that
                    // primitive as realEnv — every later unscoped access then calls
                    // Reflect.get/ownKeys on it and throws, permanently breaking process.env.
                    throw new Error(
                        'Reassigning process.env to a non-object value is not allowed — it would permanently break every future process.env access.',
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
            getCachedNativeFdGetter: () => cachedNativeFdGetter,
            setCachedNativeFdGetterOnce: (getter) => {
                if (!nativeFdGetterCaptured) {
                    cachedNativeFdGetter = getter;
                    nativeFdGetterCaptured = true;
                }
            },
        };
    });
}

const sharedState = getSharedState();

// Symbol.for(), not a plain Symbol() or object-identity check — same cross-module-instance reasoning
// as getSharedState() above: a reference-identity check would fail to recognize another evaluation's
// already-installed Proxy as "already one of these," and each would wrap the other's, looping the
// get/ownKeys/etc. traps into each other forever.
const ENV_PROXY_MARKER = Symbol.for('@dd/apps-plugin/env-guard/scoped-env-proxy');

// Re-checked on every fs.promises.open() call rather than trusted as a one-time-installed flag — a
// stray jest.spyOn(...).mockRestore() elsewhere in the process, on the same shared FileHandle
// prototype, can silently strip one of these wrappers without this file ever re-running to notice.
const FILE_HANDLE_READ_GUARD_MARKER = Symbol.for(
    '@dd/apps-plugin/env-guard/file-handle-read-guard',
);

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

// util.inspect()/console.log() read a Proxy's target directly via V8's getProxyDetails, bypassing
// every trap below — with the real env as target, that would leak it straight through a bare
// console.log(process.env) inside a scope. An always-empty, always-extensible dummy target closes
// this: Proxy invariants only constrain traps when the target is non-extensible or holds
// non-configurable properties, never true here, so every trap still resolves through
// getCurrentEnv() as before.
const INERT_PROXY_TARGET = {} as NodeJS.ProcessEnv;
// Re-checked on every runWithScopedEnv call rather than installed once and assumed permanent, since
// isEnvProxy() is what actually detects "is this already installed" — the accessor property below
// makes a bare `process.env = X` (rather than a call through this function) impossible to reach the
// real Proxy install path with, but this function still needs to stay idempotent across every
// evaluation of this file (bundled copies, Jest's per-test-file isolation) that calls it.
function ensureEnvProxyInstalled(): void {
    if (isEnvProxy(process.env)) {
        return;
    }
    const proxy = new Proxy(INERT_PROXY_TARGET, {
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
        // A non-configurable definition can never be forwarded: the Proxy invariant requires
        // `target` (INERT_PROXY_TARGET, always empty) to carry that exact property afterward, which
        // it deliberately never does. Checked upfront rather than left to surface as Reflect's own
        // invariant-violation TypeError, which gives no hint this guard is involved. Accepted gap:
        // locking an env var non-configurable stops working process-wide once local execution has
        // run once, in exchange for `console.log(process.env)` never bypassing the scope via V8's
        // getProxyDetails (see INERT_PROXY_TARGET's own comment).
        defineProperty: (_target, prop, descriptor) => {
            if (descriptor.configurable === false) {
                throw new Error(
                    `Cannot define a non-configurable property (${String(prop)}) on process.env: local execution's environment scoping requires every property to stay configurable.`,
                );
            }
            return Reflect.defineProperty(sharedState.getCurrentEnv(), prop, descriptor);
        },
        // Without this trap, Object.setPrototypeOf(process.env, ...) defaults to forwarding to
        // `target` (INERT_PROXY_TARGET, not the real env) and silently poisons its prototype chain
        // instead, even when called from inside a scope — getCurrentEnv() only affects property
        // access, not the object identity a prototype mutation lands on.
        setPrototypeOf: forwardToCurrentEnv(Reflect.setPrototypeOf),
        // Paired with setPrototypeOf above: without this trap, a customer function that sets a
        // scoped prototype and immediately reads it back would see `target`'s (INERT_PROXY_TARGET's)
        // untouched prototype instead of the one it just set on the scoped view.
        getPrototypeOf: forwardToCurrentEnv(Reflect.getPrototypeOf),
        // Can't forward to getCurrentEnv(): the Proxy invariant only honors this trap returning `true`
        // if `target` (INERT_PROXY_TARGET, not the real env) is also non-extensible, and freezing it
        // would break every other trap's scoped view. Refusing outright is the only option that
        // doesn't leak real-env state or break the proxy.
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

// A FileHandle exposes its underlying fd as a plain number via its own .fd property. Cross-checked
// against the same native getter readNativeFd()'s other callers use below, since this naive `.fd`
// read is otherwise exactly the shadow TOCTOU those callers are already hardened against.
function extractFdNumber(fdValue: unknown): unknown {
    if (typeof fdValue === 'object' && fdValue !== null && 'fd' in fdValue) {
        return readNativeFd(sharedState.getCachedNativeFdGetter(), fdValue as { fd: number });
    }
    return fdValue;
}

// Reads each of `keys` from a getter-backed options object exactly once, then rebuilds a plain
// object where a key absent from the caller's own options stays absent — see guardCpOptions's own
// comment for why re-adding an absent key as explicit `undefined` breaks Node's own cp validation.
// Shared by guardEnvironPathOrFdOption (a single always-present key) and guardCpOptions (two
// independently-optional keys): presence-conditional restore is correct for both, since a
// guaranteed-present key just never hits the "absent" branch.
function snapshotOptionKeysOnce<K extends string>(
    options: Record<string, unknown>,
    keys: readonly K[],
): Record<string, unknown> {
    // Copying every OTHER own-enumerable key first, via Object.keys rather than a `{ ...options }`
    // spread, is what keeps this to exactly one read per snapshotted key below — a spread of the
    // full options object would invoke every key's getter once on its own, then a second time when
    // that same key is explicitly snapshotted next.
    const keySet = new Set<string>(keys);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(options)) {
        if (!keySet.has(key)) {
            result[key] = options[key];
        }
    }
    for (const key of keys) {
        if (key in options) {
            result[key] = options[key];
        }
    }
    return result;
}

// createReadStream/ReadStream's options.fd (a raw fd number, or a FileHandle whose own .fd is one)
// makes Node read from that fd directly, ignoring the leading path argument — a plain
// throwIfBlockedEnvironPath(rawPath) would never see the real target. Returns a safe options
// object rather than the caller's own: options.fd could be an accessor whose getter returns a
// harmless value to this check and a different, real target to Node's own later read.
function guardEnvironPathOrFdOption(rawPath: unknown, options: unknown): unknown {
    throwIfBlockedEnvironPath(rawPath);
    // No scope active means nothing here can be an environ read worth blocking — returning options
    // untouched (rather than destructuring/rebuilding it below) preserves whatever createReadStream/
    // ReadStream call a caller outside any scope makes, including non-enumerable or inherited
    // options properties a plain spread would otherwise silently drop.
    if (!sharedState.isInsideScope()) {
        return options;
    }
    if (typeof options !== 'object' || options === null || !('fd' in options)) {
        return options;
    }
    const snapshot = snapshotOptionKeysOnce(options as Record<string, unknown>, ['fd'] as const);
    throwIfBlockedEnvironPath(extractFdNumber(snapshot.fd));
    return snapshot;
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
// their real Promise-returning contract. `onResolved`, if given, runs on the real, unguarded result
// once resolved — used only by fs.promises.open below to patch FileHandle.prototype.read from the
// first real handle it returns (see ensureFileHandleReadGuarded).
function wrapGuardedAsyncFsFn<T extends (...args: never[]) => Promise<unknown>>(
    real: T,
    onResolved?: (result: unknown) => void,
): T {
    const guarded = makeGuardWrapper(
        () => real,
        (rawPath) => isBlockedEnvironPath(rawPath),
        ENVIRON_READ_BLOCKED_MESSAGE,
        'reject',
    );
    if (!onResolved) {
        return guarded;
    }
    const wrapped = async function (this: unknown, ...args: Parameters<T>): Promise<unknown> {
        const result = await (guarded as unknown as (...a: unknown[]) => Promise<unknown>).apply(
            this,
            args,
        );
        onResolved(result);
        return result;
    } as T;
    return wrapped;
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

// Shared by every FileHandle prototype method patched below — re-checks proto[methodName] fresh on
// every fs.promises.open() call rather than trusting a one-time flag, for the same reason
// FILE_HANDLE_READ_GUARD_MARKER exists.
function originalIfUnguarded(
    proto: Record<PropertyKey, unknown>,
    methodName: string,
): ((...args: never[]) => unknown) | undefined {
    const original = proto[methodName];
    if (typeof original !== 'function') {
        return undefined;
    }
    if ((original as unknown as Record<PropertyKey, unknown>)[FILE_HANDLE_READ_GUARD_MARKER]) {
        return undefined;
    }
    return original as (...args: never[]) => unknown;
}

function markGuarded(fn: (...args: never[]) => unknown): void {
    (fn as unknown as Record<PropertyKey, unknown>)[FILE_HANDLE_READ_GUARD_MARKER] = true;
}

// A customer-controlled own property can shadow the prototype's real `fd` getter in either
// direction — reporting a harmless value to this check while `original.apply` below reads the
// real, dangerous fd, or the reverse. An untampered handle never carries an own `fd` property, so
// any divergence between the naive and native reads is itself proof of tampering.
function readNativeFd(nativeFdGetter: (() => number) | undefined, handle: { fd: number }): number {
    if (!nativeFdGetter) {
        return handle.fd;
    }
    const trueFd = nativeFdGetter.call(handle);
    if (handle.fd !== trueFd) {
        throw new Error(ENVIRON_READ_BLOCKED_MESSAGE);
    }
    return trueFd;
}

// A stateful accessor `fd` property can still defeat readNativeFd's own divergence check: return
// the validated, harmless fd on the one read the check makes, then a different, dangerous fd on
// Node's own later read(s) of the same property — read()/readFile()/readv() all re-read `handle.fd`
// more than once over a single call's lifetime. Pinning `fd` as a plain, static-value own property
// for the call's full async duration, restored to its original shape afterward, forces every read
// to resolve the one validated value instead of a getter's shifting answer.
async function withPinnedFd<T>(handle: object, fd: number, fn: () => Promise<T>): Promise<T> {
    const hasOwnFd = Object.prototype.hasOwnProperty.call(handle, 'fd');
    const priorDescriptor = hasOwnFd ? Object.getOwnPropertyDescriptor(handle, 'fd') : undefined;
    Object.defineProperty(handle, 'fd', { value: fd, configurable: true, enumerable: true });
    try {
        return await fn();
    } finally {
        if (priorDescriptor) {
            Object.defineProperty(handle, 'fd', priorDescriptor);
        } else {
            delete (handle as Record<string, unknown>).fd;
        }
    }
}

// read()/readFile()/readv() all report failure via their own returned Promise, never a
// synchronous throw.
function patchFileHandleAsyncMethod(
    proto: Record<PropertyKey, unknown>,
    methodName: string,
    nativeFdGetter: (() => number) | undefined,
): void {
    const original = originalIfUnguarded(proto, methodName);
    if (!original) {
        return;
    }
    const guarded = function (this: { fd: number }, ...args: never[]): unknown {
        // Skips readNativeFd entirely outside any scope — it calls the native .fd getter, which
        // unscoped callers must never trigger (see isBlockedEnvironPath's own short-circuit).
        if (!sharedState.isInsideScope()) {
            return original.apply(this, args);
        }
        let fd: number;
        try {
            fd = readNativeFd(nativeFdGetter, this);
        } catch (error) {
            return Promise.reject(error);
        }
        if (isBlockedEnvironPath(fd)) {
            return Promise.reject(new Error(ENVIRON_READ_BLOCKED_MESSAGE));
        }
        return withPinnedFd(this, fd, async () => original.apply(this, args));
    };
    markGuarded(guarded);
    proto[methodName] = guarded;
}

// createReadStream()/readableWebStream()/readLines() all construct and return their stream/iterator
// synchronously — the actual reads happen lazily as the caller consumes it, but a guard failure on
// the fd itself is known up front, so this matches their real, synchronous-return contract instead
// of rejecting a promise no caller of these methods is expecting.
function patchFileHandleSyncMethod(
    proto: Record<PropertyKey, unknown>,
    methodName: string,
    nativeFdGetter: (() => number) | undefined,
): void {
    const original = originalIfUnguarded(proto, methodName);
    if (!original) {
        return;
    }
    const guarded = function (this: { fd: number }, ...args: never[]): unknown {
        if (!sharedState.isInsideScope()) {
            return original.apply(this, args);
        }
        const fd = readNativeFd(nativeFdGetter, this);
        if (isBlockedEnvironPath(fd)) {
            throw new Error(ENVIRON_READ_BLOCKED_MESSAGE);
        }
        return original.apply(this, args);
    };
    markGuarded(guarded);
    proto[methodName] = guarded;
}

// FileHandle isn't part of Node's public API, so read/readFile/readv/createReadStream/
// readableWebStream/readLines are patched lazily off the first real handle fs.promises.open()
// returns — a handle obtained before that patch installs is unaffected, matching every other guard
// here. These six are distinct prototype methods that don't delegate to each other, so each needs
// its own patch; guarding .read() alone would leave the other five as unguarded, direct reads of
// the real fd.
function ensureFileHandleReadGuarded(handle: unknown): void {
    if (typeof handle !== 'object' || handle === null) {
        return;
    }
    const proto = Object.getPrototypeOf(handle) as Record<PropertyKey, unknown>;
    // Read once here, from the first real handle fs.promises.open() ever returns — before any
    // customer code has had a chance to install its own instance-level `fd` on some later handle.
    const nativeFdGetter = Object.getOwnPropertyDescriptor(proto, 'fd')?.get as
        | (() => number)
        | undefined;
    sharedState.setCachedNativeFdGetterOnce(nativeFdGetter);
    patchFileHandleAsyncMethod(proto, 'read', nativeFdGetter);
    patchFileHandleAsyncMethod(proto, 'readFile', nativeFdGetter);
    patchFileHandleAsyncMethod(proto, 'readv', nativeFdGetter);
    patchFileHandleSyncMethod(proto, 'createReadStream', nativeFdGetter);
    patchFileHandleSyncMethod(proto, 'readableWebStream', nativeFdGetter);
    // readLines() returns a readline Interface synchronously — the real reads happen lazily as the
    // caller iterates it, same reasoning as createReadStream()/readableWebStream() above.
    patchFileHandleSyncMethod(proto, 'readLines', nativeFdGetter);
}

// open/openSync/promises.open are separate entry points that map a path to a file descriptor
// without going through readFile*, so they need the same guard.
fs.readFileSync = wrapGuardedFsFn(fs.readFileSync);
fs.readFile = wrapGuardedCallbackFsFn(fs.readFile);
fs.promises.readFile = wrapGuardedAsyncFsFn(fs.promises.readFile);
fs.createReadStream = wrapGuardedStreamFn(fs.createReadStream);
fs.openSync = wrapGuardedFsFn(fs.openSync);
fs.open = wrapGuardedCallbackFsFn(fs.open);
fs.promises.open = wrapGuardedAsyncFsFn(fs.promises.open, ensureFileHandleReadGuarded);

// openAsBlob is its own entry point, separate from open*/readFile* above, and absent on Node 18.
// Feature-detected the same way packages/core/src/helpers/fs.ts's getFile() already checks for it
// — an unconditional assignment here would replace that check's `undefined` with an always-defined
// wrapper, silently forcing every Node 18 caller onto the unsupported branch.
if (typeof fs.openAsBlob === 'function') {
    fs.openAsBlob = wrapGuardedAsyncFsFn(fs.openAsBlob);
}

// read/readSync/readv/readvSync take an already-open fd as their own leading argument — the same
// shape isBlockedEnvironPath's toPathString() already resolves via /proc/self/fd for the numeric-fd
// case above, just on entry points that were never wrapped at all.
fs.read = wrapGuardedCallbackFsFn(fs.read);
fs.readSync = wrapGuardedFsFn(fs.readSync);
fs.readv = wrapGuardedCallbackFsFn(fs.readv);
fs.readvSync = wrapGuardedFsFn(fs.readvSync);

// copyFileSync/copyFile/promises.copyFile read the source file's bytes through a distinct native
// binding that never calls through readFile*/open* above — an uncovered path that could otherwise
// copy /proc/.../environ to an ordinary, unguarded file and read it back from there.
fs.copyFileSync = wrapGuardedFsFn(fs.copyFileSync);
fs.copyFile = wrapGuardedCallbackFsFn(fs.copyFile);
fs.promises.copyFile = wrapGuardedAsyncFsFn(fs.promises.copyFile);

// cp/cpSync/promises.cp additionally need to reject a recursive+dereference copy of ANY directory
// (see guardCpOptions's own comment) — a check the plain isBlockedEnvironPath(src) check above
// can't cover, since it only ever inspects the top-level source argument.
const CP_BLOCKED_MESSAGE =
    "Copying /proc/.../environ, or recursively copying with dereference: true, is not allowed in backend functions — both can expose the dev server's real, unscoped environment. Use $.Source or a declared Custom Credential instead.";

// Snapshots options.recursive/dereference into plain data properties, read exactly once — the
// generic makeGuardWrapper machinery forwards a caller's original options object unchanged, which
// would let a getter-backed recursive/dereference report false here and true when Node's own
// fs.cp* reads it again internally, letting a symlinked /proc/.../environ get dereferenced and
// copied through undetected. Same TOCTOU reasoning as guardEnvironPathOrFdOption's options.fd
// handling above; hand-rolled here since arg transformation isn't something makeGuardWrapper
// supports.
function guardCpOptions(options: unknown): unknown {
    if (!sharedState.isInsideScope()) {
        return options;
    }
    if (typeof options !== 'object' || options === null) {
        return options;
    }
    // Node's cp implementations distinguish an absent key (defaulted internally) from one
    // explicitly present with value `undefined` (rejected by its own validation), so
    // snapshotOptionKeysOnce restoring both keys unconditionally would turn a caller's
    // `{ recursive: true }` (no dereference key at all) into `{ recursive: true, dereference:
    // undefined }` and throw a validation error that never happens when the real options object is
    // forwarded as-is — this is why it only re-adds keys actually present on the caller's options.
    const safeOptions = snapshotOptionKeysOnce(
        options as Record<string, unknown>,
        ['recursive', 'dereference'] as const,
    );
    if (safeOptions.recursive === true && safeOptions.dereference === true) {
        throw new Error(CP_BLOCKED_MESSAGE);
    }
    return safeOptions;
}

// Captured into local consts before reassignment below — a lazy `() => fs.cpSync` getter would
// re-read the property AFTER it's replaced with this very wrapper, recursing into itself forever.
const originalCpSync = fs.cpSync;
const originalCp = fs.cp;
const originalPromisesCp = fs.promises.cp;

// cpSync is genuinely synchronous — a guard failure throwing matches its real contract. `this`
// is forwarded via .apply, matching every other guarded fs entry point in this file — Node's own
// implementations don't consult it, but nothing here should be the one silent exception.
fs.cpSync = function (this: unknown, src: unknown, dest: unknown, options?: unknown) {
    throwIfBlockedEnvironPath(src);
    const safeOptions = guardCpOptions(options) as fs.CopySyncOptions;
    return originalCpSync.apply(this, [src as string | URL, dest as string | URL, safeOptions]);
} as typeof fs.cpSync;

// cp reports failure via an error-first callback, never a synchronous throw. Only the guard's own
// decision logic runs inside the try/catch — the real call runs outside it, so a synchronous throw
// from Node's own validation propagates normally instead of being swallowed by invokeCallbackArg
// when a malformed call has no valid callback to report through.
fs.cp = function (this: unknown, src: unknown, dest: unknown, ...rest: unknown[]) {
    let safeArgs: unknown[];
    try {
        throwIfBlockedEnvironPath(src);
        const hasOptions = rest.length > 1;
        const safeOptions = hasOptions ? guardCpOptions(rest[0]) : undefined;
        safeArgs = hasOptions ? [src, dest, safeOptions, ...rest.slice(1)] : [src, dest, ...rest];
    } catch (error) {
        invokeCallbackArg(
            [src, dest, ...rest],
            error instanceof Error ? error : new Error(String(error)),
        );
        return undefined;
    }
    return (originalCp as unknown as (...a: unknown[]) => unknown).apply(this, safeArgs);
} as typeof fs.cp;

// promises.cp rejects, matching its real Promise-returning contract.
fs.promises.cp = async function (this: unknown, src: unknown, dest: unknown, options?: unknown) {
    throwIfBlockedEnvironPath(src);
    const safeOptions = guardCpOptions(options) as fs.CopyOptions;
    return originalPromisesCp.apply(this, [src as string | URL, dest as string | URL, safeOptions]);
} as typeof fs.promises.cp;

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

// @types/node doesn't declare fs.FileReadStream at all, even though Node itself still exports it.
// `let`, not `const` — ReadStream itself is declared as a class (an assignable binding, matching
// the reassignment already made above), and this needs to be assignable too.
declare module 'fs' {
    // no-undef doesn't understand module-augmentation scoping (ReadStream is 'fs's own ambient
    // class, visible here without an import); import/no-mutable-exports doesn't apply either — this
    // `let` declares the shape of the 'fs' module's own property, not a real value this file exports.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-undef, import/no-mutable-exports
    export let FileReadStream: typeof ReadStream;
}

// fs.FileReadStream is a real, long-deprecated alias for fs.ReadStream — reassigning fs.ReadStream
// only rebinds that one property; fs.FileReadStream is a separate slot that keeps pointing at the
// original, unwrapped class, so `new fs.FileReadStream(path)` would construct through it with no
// guard at all.
fs.FileReadStream = fs.ReadStream;

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
// Gated on sharedState.isInsideScope(), not a global scope count — forceResetEnv() clears the
// count for an abandoned execution whose fn() is still running, and keying redaction on that count
// would let the zombie's own getReport()/writeReport() call see the real environment the moment the
// count resets, even though its own continuation never actually closed.
const originalGetReport = process.report.getReport.bind(process.report);
process.report.getReport = wrapReportFn(originalGetReport, (original, ...args) => {
    const report = original(...args);
    if (sharedState.isInsideScope() && hasEnvironmentVariables(report)) {
        delete report.environmentVariables;
    }
    return report;
});

// writeReport(fileName) can target a non-regular destination — a FIFO, socket, or character device
// like /dev/stdout — and Node writes the real, unredacted report straight there before this wrap
// can read it back and strip environmentVariables. Redacting after the fact can't undo bytes
// already delivered to whatever's reading the other end, so refusing the call once the destination
// is verified non-regular is the only option that can't leak.
const WRITE_REPORT_NON_REGULAR_SINK_MESSAGE =
    "process.report.writeReport() to a non-regular destination (a pipe, socket, or similar) is not allowed in backend functions — Node would write its real, unscoped report there before this file's own redaction could ever run. Use $.Source or a declared Custom Credential instead.";

// A not-yet-existing path is fine — writeReport creates a fresh, ordinary regular file there —
// so ENOENT is the one failure treated as "not a non-regular sink," matching isEnvironPath's own
// identical ENOENT fallback elsewhere in this file. fs.statSync follows symlinks on its own,
// unlike lstatSync, so a symlink pointing at a FIFO is resolved to its real target automatically.
function isVerifiedNonRegularDestination(filePath: string): boolean {
    try {
        return !fs.statSync(filePath).isFile();
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

const originalWriteReport = process.report.writeReport.bind(process.report);
process.report.writeReport = wrapReportFn(originalWriteReport, (original, ...args) => {
    if (sharedState.isInsideScope()) {
        // writeReport(fileName?, err?) also accepts writeReport(err?) with no fileName at all —
        // only a string first argument is ever a caller-chosen destination, so this branch is
        // skipped (falling through to Node's own write below) when none was given.
        // Checked as the last statement before the real write, not earlier in this function: an
        // external process could swap a symlink at fileNameArg between this check and the write
        // below. This doesn't close that window entirely (the write is still a separate syscall
        // right after), but narrows it to two back-to-back synchronous calls with nothing between.
        const fileNameArg = args[0];
        if (typeof fileNameArg === 'string') {
            if (isVerifiedNonRegularDestination(fileNameArg)) {
                throw new Error(WRITE_REPORT_NON_REGULAR_SINK_MESSAGE);
            }
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
