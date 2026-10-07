// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global Proxy */

import child_process from 'child_process';
import fs from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import worker_threads from 'worker_threads';

import type { BackendRuntime } from '../backend-runtime';

// No OS sandbox: JS-level blocks scoped per call via AsyncLocalStorage, following the org's runtime.
// v1 blocks subprocesses, worker threads and writes outside os.tmpdir() and /tmp; v2 only blocks
// in-process writes that could reach the Vite project root or that it can't check.

// Targets accidental dependency behavior, not hostile code, which can read the dev server's
// credentials in process.env, use the network, reach the `fs` registry. Only runBlocked is guarded.

// Residual gaps: a v2 subprocess or worker isn't guarded, a socket or pipe listener creates its file
// unguarded, and writes on an fd or handle opened outside the current run are refused even where
// writes are permitted, so such a stream's 'error' can crash the server.

export const SUBPROCESS_BLOCKED_MESSAGE =
    'Spawning a subprocess is blocked because the v1 backend function runtime does not allow it.';
export const WORKER_THREAD_BLOCKED_MESSAGE =
    'Spawning a worker thread is blocked because the v1 backend function runtime does not allow it.';
export const FILE_HANDLE_GUARD_UNAVAILABLE_MESSAGE =
    'Local execution could not guard file handles, so it refuses to run.';
export const FS_WRITE_BLOCKED_MESSAGE =
    'Writing outside os.tmpdir() or /tmp is blocked because the v1 backend function runtime does not allow it.';
export const LINK_OR_COPY_BLOCKED_MESSAGE =
    'Creating a symlink or running cp is blocked by a local-only protection, so no link can redirect a later write out of os.tmpdir() or /tmp.';
export const RECURSIVE_COPY_BLOCKED_MESSAGE =
    'Copying a directory recursively with cp is blocked by a local-only protection, since a symlink inside its destination could lead the copy into the Vite project root.';
export const ENDED_RUN_WRITE_BLOCKED_MESSAGE =
    'Writing from a backend function run that already ended is blocked by a local-only protection.';
export const UNCHECKABLE_WRITE_BLOCKED_MESSAGE =
    "Writing through a file descriptor or handle this run doesn't have open for writing is blocked by a local-only protection, since the file it points to cannot be checked.";
export const UNCHECKABLE_PATH_BLOCKED_MESSAGE =
    "Writing to a path that cannot be resolved, such as one through a dangling symlink, a Buffer that isn't valid UTF-8, or an object local execution doesn't recognize as a path, is blocked by a local-only protection.";
export const PROJECT_WRITE_BLOCKED_MESSAGE =
    "Writing to the Vite project root (the Vite config's root, or else the working directory), anything inside it, or its parent directories is blocked by a local-only protection.";

export const RUNTIME_FALLBACK_NOTE = "(v1 rules apply because the org's runtime couldn't be read)";

export function withRuntimeFallbackNote(message: string): string {
    return `${message.replace(/\.$/, '')} ${RUNTIME_FALLBACK_NOTE}.`;
}

type RunPolicy =
    | {
          readonly runtime: 'v1';
          readonly isFallback: boolean;
          readonly projectRoots: readonly string[];
      }
    | { readonly runtime: 'v2'; readonly projectRoots: readonly string[] };

/** One `runBlocked` call's fds and FileHandles opened for writing; `closed` once the run ends. */
export interface BlockedScope {
    readonly writableFds: Set<number>;
    readonly writableHandles: WeakSet<object>;
    // Absent on a scope from an older copy of this file, which then keeps v1's blocks.
    readonly policy?: RunPolicy;
    closed: boolean;
}

interface GuardedAsyncContext {
    current(): BlockedScope | undefined;
    run<T>(scope: BlockedScope, fn: () => T): T;
    exit<T>(fn: () => T): T;
}

function isGuardedAsyncContext(value: unknown): value is GuardedAsyncContext {
    return (
        typeof value === 'object' &&
        value !== null &&
        'current' in value &&
        'run' in value &&
        'exit' in value &&
        typeof value.current === 'function' &&
        typeof value.run === 'function' &&
        typeof value.exit === 'function'
    );
}

// Versioned so a copy from another plugin release, which stores a different shape under older
// keys, can't make this copy throw at load.
const NETWORK_GUARD_SYMBOL_PREFIX = '@dd/apps-plugin/network-guard/v3';

export function networkGuardSymbol(name: string): symbol {
    return Symbol.for(`${NETWORK_GUARD_SYMBOL_PREFIX} ${name}`);
}

// Stored on `fs` because core modules are the only state shared across this file's multiple
// evaluations (bundled copies, Jest per-file isolation). The frozen facade keeps other code from
// `.disable()`-ing the store; the own-property lookup keeps a polluted prototype from faking an install.
function getSharedEntry<T>(
    key: string,
    create: () => T,
    isValid: (value: unknown) => value is T,
): T {
    const symbol = networkGuardSymbol(key);
    if (!Object.prototype.hasOwnProperty.call(fs, symbol)) {
        const value = create();
        Object.defineProperty(fs, symbol, {
            value,
            writable: false,
            configurable: false,
            enumerable: false,
        });
        return value;
    }
    const stored: unknown = Reflect.get(fs, symbol);
    if (!isValid(stored)) {
        throw new Error(`Internal error: the "${key}" network-guard registry entry is not valid.`);
    }
    return stored;
}

function createGuardedAsyncContext(): GuardedAsyncContext {
    const context = new AsyncLocalStorage<BlockedScope>();
    return Object.freeze({
        current: () => context.getStore(),
        run: <T>(scope: BlockedScope, fn: () => T) => context.run(scope, fn),
        exit: <T>(fn: () => T) => context.exit(fn),
    });
}

export function getSharedContext(key: string): GuardedAsyncContext {
    return getSharedEntry(key, createGuardedAsyncContext, isGuardedAsyncContext);
}

type ScopeRegistry = Pick<Set<BlockedScope>, 'add' | 'delete' | 'forEach'>;

function isScopeRegistry(value: unknown): value is ScopeRegistry {
    return (
        typeof value === 'object' &&
        value !== null &&
        'add' in value &&
        'delete' in value &&
        'forEach' in value &&
        typeof value.add === 'function' &&
        typeof value.delete === 'function' &&
        typeof value.forEach === 'function'
    );
}

// Scoped to the active `runBlocked` call's async chain, not process-wide, so unrelated concurrent
// callers aren't blocked too. Created on first use, so importing this file has no side effects.
let blockedContext: GuardedAsyncContext | undefined;
function getBlockedContext(): GuardedAsyncContext {
    blockedContext ??= getSharedContext('blockedContext');
    return blockedContext;
}

// Runs still pending, across every copy of this file: only the first copy's fs.close guard is
// installed, and it must see every run's fds.
let openScopes: ScopeRegistry | undefined;
function getOpenScopes(): ScopeRegistry {
    openScopes ??= getSharedEntry('openScopes', () => new Set<BlockedScope>(), isScopeRegistry);
    return openScopes;
}

function followsV2(scope: BlockedScope): boolean {
    return scope.policy?.runtime === 'v2';
}

function v1Message(scope: BlockedScope, message: string): string {
    const { policy } = scope;
    return policy?.runtime === 'v1' && policy.isFallback
        ? withRuntimeFallbackNote(message)
        : message;
}

function v1OnlyRefusal(message: string): string | undefined {
    const scope = getBlockedContext().current();
    return scope === undefined || followsV2(scope) ? undefined : v1Message(scope, message);
}

function subprocessRefusal(): string | undefined {
    return v1OnlyRefusal(SUBPROCESS_BLOCKED_MESSAGE);
}

// `Symbol.for` so re-evaluations recognize an installed guard; unversioned so another release's
// copy (whose accessors are non-configurable) is recognized too, rather than crashing on redefine.
export const ALREADY_GUARDED = Symbol.for('@dd/apps-plugin/network-guard installed');

// Marks accessors installed by this guard generation. An accessor with only ALREADY_GUARDED came
// from another release whose wrappers consult that release's own context, so this copy can't block.
const GUARD_GENERATION = networkGuardSymbol('installed');
let foreignGuardFound = false;
// Marks accessors whose wrappers follow a scope's `policy`; released ones share this generation's
// context but apply v1's blocks to every run.
const FOLLOWS_POLICY = Symbol.for('@dd/apps-plugin/network-guard follows policy');
let olderGuardFound = false;

export const FOREIGN_GUARD_MESSAGE =
    'Local execution is unavailable: another version of the Datadog apps plugin in this process already guards Node built-ins, so this version cannot block filesystem writes or subprocesses. Install a single version of the Datadog build plugins.';

export const OLDER_GUARD_MESSAGE =
    "Local execution can't follow the v2 backend function runtime: an older version of the Datadog apps plugin in this process already guards Node built-ins with v1's rules. Install a single version of the Datadog build plugins.";

export function assertNoForeignGuard(): void {
    if (foreignGuardFound) {
        throw new Error(FOREIGN_GUARD_MESSAGE);
    }
}

function isObjectLike(value: unknown): value is object {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/**
 * Permanent getter/setter — a detached callback can still fire after `runBlocked` resolves and
 * must stay blocked. The setter rebuilds the guard on every write since some libraries (e.g. MSW)
 * mark the last function object they saw as "already patched," and reusing one frozen object
 * collides. Non-configurable, so a dependency can't swap the whole descriptor; plain reassignment
 * still works. Re-installing on an already-guarded property is a no-op via `ALREADY_GUARDED`.
 */
export function installGuardedProperty<T>(
    target: object,
    prop: string,
    makeGuard: (getReal: () => T) => T,
): void {
    const existingGetter = Object.getOwnPropertyDescriptor(target, prop)?.get;
    if (existingGetter && Reflect.get(existingGetter, ALREADY_GUARDED) === true) {
        if (Reflect.get(existingGetter, GUARD_GENERATION) !== true) {
            foreignGuardFound = true;
        } else if (Reflect.get(existingGetter, FOLLOWS_POLICY) !== true) {
            olderGuardFound = true;
        }
        return;
    }

    let real = (target as Record<string, T>)[prop];
    if (real === undefined) {
        // Nothing to guard — this runtime doesn't expose this method/global. A wrapper here would
        // make feature-detection lie.
        return;
    }
    // Tracks which `real` was active when each guard was built — the "const original = x; x =
    // mock; x = original;" idiom hands the guard itself back on restore, and without this map that
    // would make the guard call itself forever.
    const realAtGuardCreation = new WeakMap<object, T>();

    function buildGuard(): T {
        // Closes over its own snapshot of `real`, not the shared variable — a wrapper-closure
        // restore would otherwise read whatever `real` currently holds and recurse forever.
        const capturedReal = real;
        // A non-function stub (undefined, null, false...) reads back as assigned, so feature detection stays accurate.
        if (typeof capturedReal !== 'function') {
            return capturedReal;
        }
        const guard = makeGuard(() => capturedReal);
        if (isObjectLike(guard)) {
            realAtGuardCreation.set(guard, real);
        }
        return guard;
    }

    let currentGuard = buildGuard();
    // Values assigned through a receiver that owns a copy of this accessor (graceful-fs clones fs's
    // descriptors), which can't be shadowed with a data property since the copy is non-configurable.
    const cloneOverrides = new WeakMap<object, { value: T }>();
    function getter(this: unknown): T {
        const override = isObjectLike(this) ? cloneOverrides.get(this) : undefined;
        return override ? override.value : currentGuard;
    }
    Object.defineProperty(getter, ALREADY_GUARDED, { value: true });
    Object.defineProperty(getter, GUARD_GENERATION, { value: true });
    Object.defineProperty(getter, FOLLOWS_POLICY, { value: true });
    // A plain `function`, not an arrow, so `this` is the real receiver — needed to tell
    // `ChildProcess.prototype.spawn = mock` (every instance) apart from `oneChild.spawn = mock`
    // (one instance) when `target` is a shared prototype.
    function setter(this: unknown, value: T): void {
        // Some Node/Jest internals call this with a non-object receiver; those take the shared path.
        if (this !== target && isObjectLike(this)) {
            if (Object.getOwnPropertyDescriptor(this, prop)?.set === setter) {
                cloneOverrides.set(this, { value });
                return;
            }
            // `target` is a shared prototype — shadow the guard on this instance only, like an
            // unguarded assignment would, instead of repointing the delegate every other
            // instance's guard calls through.
            Object.defineProperty(this, prop, {
                value,
                writable: true,
                configurable: true,
                enumerable: true,
            });
            return;
        }
        const realForGuard = isObjectLike(value) ? realAtGuardCreation.get(value) : undefined;
        real = realForGuard ?? value;
        currentGuard = buildGuard();
    }
    Object.defineProperty(target, prop, {
        configurable: false,
        enumerable: true,
        get: getter,
        set: setter,
    });
}

function isFunction(value: unknown): value is (...args: unknown[]) => void {
    return typeof value === 'function';
}

// Node's error-first callback is always the last argument. Returns whether one was found, so a
// caller can fall back to an 'error' event.
function invokeCallbackArg(args: unknown[], err: Error, ...extraArgs: unknown[]): boolean {
    const maybeCallback = args[args.length - 1];
    if (isFunction(maybeCallback)) {
        process.nextTick(maybeCallback, err, ...extraArgs);
        return true;
    }
    return false;
}

// Deferred via process.nextTick so a listener attached right after the call still sees it,
// matching a real event-emission timing.
function emitAsyncErrorIfListened(target: EventEmitter, err: Error): void {
    process.nextTick(() => {
        if (target.listenerCount('error') > 0) {
            target.emit('error', err);
        }
    });
}

// 'throw' is for APIs that throw synchronously (spawnSync/execSync); 'reject' for Promise-returning
// ones; 'callback' for fs's callback APIs, which report failure through their error-first callback.
// `refusal` gives the blocked message, or undefined to call through; `errorCode` is set on the error.
function makeGuardWrapper<F extends (...args: never[]) => unknown>(
    getReal: () => F,
    refusal: () => string | undefined,
    onBlocked: 'throw' | 'reject' | 'callback',
    errorCode?: string,
): F {
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        const blockedMessage = refusal();
        if (blockedMessage === undefined) {
            const real = getReal();
            return Reflect.apply(real, this, args);
        }
        const blockedError = Object.assign(
            new Error(blockedMessage),
            errorCode ? { code: errorCode } : {},
        );
        if (onBlocked === 'reject') {
            return Promise.reject(blockedError);
        }
        if (onBlocked === 'callback') {
            if (invokeCallbackArg(args, blockedError)) {
                return undefined;
            }
            // Real fs throws this synchronously for a missing callback regardless of block state.
            const message = 'The "cb" argument must be of type function. Received undefined';
            const missingCallbackError = new TypeError(message);
            throw Object.assign(missingCallbackError, { code: 'ERR_INVALID_ARG_TYPE' });
        }
        throw blockedError;
    };
    const real = getReal();
    copyPromisifyMetadata(real, wrapper);
    return wrapper as unknown as F;
}

// Node marks some fs functions (e.g. fs.write) with an internal symbol telling util.promisify to
// resolve with a named-field object; a wrapper without it resolves with only the first value.
// promisify.custom is skipped, since the real one would call past the guard.
function copyPromisifyMetadata(real: unknown, wrapper: object): void {
    if (!isObjectLike(real)) {
        return;
    }
    for (const key of Object.getOwnPropertySymbols(real)) {
        const descriptor = Object.getOwnPropertyDescriptor(real, key);
        if (key !== promisify.custom && descriptor) {
            Object.defineProperty(wrapper, key, descriptor);
        }
    }
}

// A worker gets a fresh V8 realm with its own module registry, so nothing inside it inherits this
// file's monkeypatches — blocking construction is the only enforceable boundary. The construct
// trap forwards `newTarget`, so `class Foo extends Worker {}` still produces a Foo.
export function guardWorker(getReal: () => unknown): unknown {
    const real = getReal();
    // Worker reassigned to a non-constructor stub reads back as assigned.
    if (typeof real !== 'function') {
        return real;
    }
    return new Proxy(real, {
        construct(target, args, newTarget) {
            const refusal = v1OnlyRefusal(WORKER_THREAD_BLOCKED_MESSAGE);
            if (refusal !== undefined) {
                throw new Error(refusal);
            }
            return Reflect.construct(target, args, newTarget);
        },
    });
}

// execSync/execFileSync genuinely throw synchronously on failure — this guard is for those two
// only. The rest have their own guards below matching each one's real (never-throws) contract.
function guardSubprocess<F extends (...args: never[]) => unknown>(getReal: () => F): F {
    return makeGuardWrapper(getReal, subprocessRefusal, 'throw');
}

// spawn()/fork() return a brand-new ChildProcess with no existing `this` to emit 'error' on, so
// the guard fabricates a stub shaped like the real return value instead of `undefined` (which
// would TypeError on `spawn(...).stdout.on(...)`). stdout/stderr/stdin are real inert streams, not
// null, matching a real launch failure. send()/disconnect() are included even for spawn/exec/
// execFile (which lack IPC by default) — this guard is dev-loop safety, not a hard security
// boundary, and avoiding a crash matters more than exact fidelity.
function createBlockedChildProcessStub(err: Error): EventEmitter & Record<string, unknown> {
    const stub = new EventEmitter() as EventEmitter & Record<string, unknown>;
    stub.pid = undefined;
    stub.exitCode = null;
    stub.signalCode = null;
    stub.killed = false;
    stub.connected = false;
    stub.channel = undefined;
    const stdout = new Readable({ read() {} });
    stdout.push(null);
    const stderr = new Readable({ read() {} });
    stderr.push(null);
    stub.stdout = stdout;
    stub.stderr = stderr;
    stub.stdin = new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        },
    });
    stub.kill = () => false;
    stub.ref = () => stub;
    stub.unref = () => stub;
    stub.disconnect = () => {};
    stub.send = (...sendArgs: unknown[]) => {
        const sendErr = new Error('channel closed');
        if (!invokeCallbackArg(sendArgs, sendErr)) {
            // No callback given — fall back to the 'error' event a real disconnected channel uses.
            emitAsyncErrorIfListened(stub, sendErr);
        }
        return false;
    };
    emitAsyncErrorIfListened(stub, err);
    return stub;
}

function guardSpawnFactory<F extends (...args: never[]) => unknown>(getReal: () => F): F {
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        const refusal = subprocessRefusal();
        if (refusal === undefined) {
            return (getReal() as unknown as (...a: unknown[]) => unknown).apply(this, args);
        }
        return createBlockedChildProcessStub(new Error(refusal));
    };
    return wrapper as unknown as F;
}

// exec/execFile report failure via an error-first callback and always return a ChildProcess
// synchronously. Real Node sets stdout/stderr to empty strings, not undefined, even on a launch
// failure — a caller doing `err.stderr.trim()` would otherwise TypeError.
function guardExecFactory<F extends (...args: never[]) => unknown>(getReal: () => F): F {
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        const refusal = subprocessRefusal();
        if (refusal === undefined) {
            return (getReal() as unknown as (...a: unknown[]) => unknown).apply(this, args);
        }
        const err = new Error(refusal);
        invokeCallbackArg(args, err, '', '');
        return createBlockedChildProcessStub(err);
    };
    return wrapper as unknown as F;
}

// ChildProcess.prototype.spawn() configures an existing instance, so there's no factory return
// value to fabricate — just this instance's async 'error' event. The real method returns a
// synchronous integer (0 success, negative errno on failure), so the blocked path returns a
// negative placeholder. This method's `this` type isn't part of @types/node's public surface (see
// the childProcessPrototype cast below), so it needs its own guard rather than reusing another.
function guardChildProcessSpawnMethod<F extends (...args: never[]) => unknown>(
    getReal: () => F,
): F {
    const wrapper = function (this: EventEmitter, ...args: unknown[]): unknown {
        const refusal = subprocessRefusal();
        if (refusal === undefined) {
            return (getReal() as unknown as (...a: unknown[]) => unknown).apply(this, args);
        }
        emitAsyncErrorIfListened(this, new Error(refusal));
        return -1;
    };
    return wrapper as unknown as F;
}

// spawnSync never throws either — it returns a SpawnSyncReturns-shaped object with `.error` set,
// so the guard mirrors that shape. `output` is null on a real launch failure, not an array — a
// caller doing `result.output[1].toString()` would otherwise TypeError against a naive stub.
function guardSpawnSyncResult<F extends (...args: never[]) => unknown>(getReal: () => F): F {
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        const refusal = subprocessRefusal();
        if (refusal === undefined) {
            return (getReal() as unknown as (...a: unknown[]) => unknown).apply(this, args);
        }
        return {
            pid: 0,
            output: null,
            stdout: undefined,
            stderr: undefined,
            status: null,
            signal: null,
            error: new Error(refusal),
        };
    };
    return wrapper as unknown as F;
}

/**
 * exec/execFile's native `promisify.custom` lives on the specific function object, so a fresh
 * wrapper silently drops it, while reusing the original symbol would bypass the guard. Calls the
 * already-guarded `wrapper` and attaches `.child` to match Node's real `PromiseWithChild`
 * contract.
 */
function guardExecWithPromisifyCustom<F extends (...args: never[]) => unknown>(
    getReal: () => F,
): F {
    const wrapper = guardExecFactory(getReal);
    Object.defineProperty(wrapper, promisify.custom, {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => {
            let child: unknown;
            const promise = new Promise((resolve, reject) => {
                child = (wrapper as unknown as (...a: unknown[]) => unknown)(
                    ...args,
                    (error: unknown, stdout: unknown, stderr: unknown) => {
                        if (error) {
                            const errorWithOutput = Object.assign(error as object, {
                                stdout,
                                stderr,
                            });
                            reject(errorWithOutput);
                        } else {
                            resolve({ stdout, stderr });
                        }
                    },
                );
            });
            (promise as unknown as { child: unknown }).child = child;
            return promise;
        },
    });
    return wrapper;
}

function installSubprocessGuards(): void {
    installGuardedProperty<typeof child_process.spawn>(child_process, 'spawn', guardSpawnFactory);
    installGuardedProperty<typeof child_process.spawnSync>(
        child_process,
        'spawnSync',
        guardSpawnSyncResult,
    );
    // `unknown` is the correct escape hatch: exec/execFile's `__promisify__` property doesn't structurally satisfy a plain function type.
    installGuardedProperty<(...args: never[]) => unknown>(
        child_process,
        'exec',
        guardExecWithPromisifyCustom,
    );
    installGuardedProperty<typeof child_process.execSync>(
        child_process,
        'execSync',
        guardSubprocess,
    );
    installGuardedProperty<(...args: never[]) => unknown>(
        child_process,
        'execFile',
        guardExecWithPromisifyCustom,
    );
    installGuardedProperty<typeof child_process.execFileSync>(
        child_process,
        'execFileSync',
        guardSubprocess,
    );
    installGuardedProperty<(...args: never[]) => unknown>(child_process, 'fork', guardSpawnFactory);
    // Also guards `ChildProcess.prototype.spawn` directly, since the functions above are thin wrappers a dependency could bypass them through.
    const childProcessPrototype = child_process.ChildProcess.prototype as unknown as Record<
        string,
        unknown
    >;
    installGuardedProperty<(...args: never[]) => unknown>(
        childProcessPrototype,
        'spawn',
        guardChildProcessSpawnMethod,
    );

    installGuardedProperty<unknown>(worker_threads, 'Worker', guardWorker);
}

// Only writes are guarded (reads stay open). Blocked errors use EROFS, since graceful-fs's win32
// rename retries EACCES/EPERM for a minute.
type FsWriteFn = (...args: never[]) => unknown;
type FsWriteGuard = (getReal: () => FsWriteFn) => FsWriteFn;
type FsWriteForm = 'sync' | 'callback' | 'promise';
const FS_ON_BLOCKED = { sync: 'throw', callback: 'callback', promise: 'reject' } as const;

// The `EitherWay` refusals are v1 refusals v2 would make too.
type WriteRefusal =
    | 'refused'
    | 'refusedEitherWay'
    | 'linkOrCopy'
    | 'linkOrCopyEitherWay'
    | 'recursiveCopy'
    | 'endedRun'
    | 'uncheckable'
    | 'uncheckablePath';
type WriteVerdict = 'permitted' | WriteRefusal;
const V1_WRITE_MESSAGES = {
    refused: FS_WRITE_BLOCKED_MESSAGE,
    linkOrCopy: LINK_OR_COPY_BLOCKED_MESSAGE,
    endedRun: ENDED_RUN_WRITE_BLOCKED_MESSAGE,
};

// Refusals v2 would make too never get the fallback note.
function writeRefusalMessage(scope: BlockedScope, refusal: WriteRefusal): string {
    if (refusal === 'uncheckable') {
        return UNCHECKABLE_WRITE_BLOCKED_MESSAGE;
    }
    if (refusal === 'uncheckablePath') {
        return UNCHECKABLE_PATH_BLOCKED_MESSAGE;
    }
    if (refusal === 'recursiveCopy') {
        return RECURSIVE_COPY_BLOCKED_MESSAGE;
    }
    if (refusal === 'refusedEitherWay') {
        return FS_WRITE_BLOCKED_MESSAGE;
    }
    if (refusal === 'linkOrCopyEitherWay') {
        return LINK_OR_COPY_BLOCKED_MESSAGE;
    }
    if (followsV2(scope)) {
        return PROJECT_WRITE_BLOCKED_MESSAGE;
    }
    return v1Message(scope, V1_WRITE_MESSAGES[refusal]);
}

function makeFsRefusal(getReal: () => FsWriteFn, form: FsWriteForm, refusal: WriteRefusal) {
    const message = () => {
        const scope = getBlockedContext().current();
        return scope === undefined ? undefined : writeRefusalMessage(scope, refusal);
    };
    return makeGuardWrapper(getReal, message, FS_ON_BLOCKED[form], 'EROFS');
}

function makeFsRefusals(getReal: () => FsWriteFn, form: FsWriteForm) {
    return {
        refused: makeFsRefusal(getReal, form, 'refused'),
        refusedEitherWay: makeFsRefusal(getReal, form, 'refusedEitherWay'),
        linkOrCopy: makeFsRefusal(getReal, form, 'linkOrCopy'),
        linkOrCopyEitherWay: makeFsRefusal(getReal, form, 'linkOrCopyEitherWay'),
        recursiveCopy: makeFsRefusal(getReal, form, 'recursiveCopy'),
        endedRun: makeFsRefusal(getReal, form, 'endedRun'),
        uncheckable: makeFsRefusal(getReal, form, 'uncheckable'),
        uncheckablePath: makeFsRefusal(getReal, form, 'uncheckablePath'),
    } satisfies Record<WriteRefusal, FsWriteFn>;
}

const OPEN_WRITE_FLAG_BITS = [
    fs.constants.O_WRONLY,
    fs.constants.O_RDWR,
    fs.constants.O_CREAT,
    fs.constants.O_TRUNC,
    fs.constants.O_APPEND,
];
// Each constant is a single power-of-two bit; tested arithmetically since the repo lints out bitwise operators.
function hasFlagBit(flags: number, bit: number): boolean {
    return Math.floor(flags / bit) % 2 === 1;
}
// Flags are the second argument; omitted (or a callback in that position) means 'r'.
function opensForWriting(args: unknown[]): boolean {
    const flags = args[1];
    if (typeof flags === 'number') {
        // A negative or fractional value can't be bit-tested reliably, so it's treated as a write.
        if (!Number.isInteger(flags) || flags < 0) {
            return true;
        }
        return OPEN_WRITE_FLAG_BITS.some((bit) => hasFlagBit(flags, bit));
    }
    return typeof flags === 'string' && /[wa+]/.test(flags);
}

function toFilePath(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (value instanceof Uint8Array) {
        const decoded = Buffer.from(value).toString();
        // A path that doesn't survive a UTF-8 round trip names a different file than the one checked.
        const roundTripped = Buffer.from(decoded);
        return roundTripped.equals(value) ? decoded : undefined;
    }
    if (value instanceof URL && value.protocol === 'file:') {
        // Throws for a URL no file path matches, such as one with an encoded separator.
        try {
            return fileURLToPath(value);
        } catch {
            return undefined;
        }
    }
    return undefined;
}

function existsWithoutFollowingLinks(candidate: string): boolean {
    try {
        fs.lstatSync(candidate);
        return true;
    } catch {
        return false;
    }
}

// Where the kernel lands a write: never textually normalized, since path.resolve and fs.realpathSync
// collapse `link/..` while the kernel follows the link first. A dangling link or a `..` past a
// missing segment resolves to nothing and is refused.
function realPathForWrite(filePath: string): string | undefined {
    const cwd = process.cwd();
    const target = path.isAbsolute(filePath) ? filePath : `${cwd}${path.sep}${filePath}`;
    const missingSegments: string[] = [];
    let current = target;
    while (!existsWithoutFollowingLinks(current)) {
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        const missingSegment = path.basename(current);
        missingSegments.unshift(missingSegment);
        current = parent;
    }
    if (missingSegments.includes('..')) {
        return undefined;
    }
    try {
        const realPath = fs.realpathSync.native(current);
        return path.join(realPath, ...missingSegments);
    } catch {
        return undefined;
    }
}

// Where the kernel resolves the directory entry an operation like unlink or rename acts on: through
// its parent's links but not the final component's. A trailing separator or a `.`/`..` name makes
// the kernel follow the final component, so those take the full resolution.
function realEntryPath(filePath: string): string | undefined {
    const name = path.basename(filePath);
    if (filePath.endsWith(path.sep) || name === '' || name === '.' || name === '..') {
        return realPathForWrite(filePath);
    }
    const parentPath = path.dirname(filePath);
    const realParent = realPathForWrite(parentPath);
    return realParent === undefined ? undefined : path.join(realParent, name);
}

// The real OS temp dir, plus /tmp outside Windows, resolved at install. Libraries like tempy and
// temp-dir save os.tmpdir() when they load, and Terrapin's os.tmpdir() is /tmp, which some
// dependencies hard-code.
let realTmpDirs: string[] | undefined;

function captureRealTmpDirs(): string[] | undefined {
    const tmpDirs = process.platform === 'win32' ? [os.tmpdir()] : [os.tmpdir(), '/tmp'];
    const realDirs = tmpDirs.flatMap((tmpDir) => {
        try {
            return [fs.realpathSync.native(tmpDir)];
        } catch {
            return [];
        }
    });
    return realDirs.length > 0 ? [...new Set(realDirs)] : undefined;
}

interface PathRule {
    readonly operatesOnEntry: boolean;
    readonly allowsRoot: boolean;
}
const WRITE_THROUGH_PATH: PathRule = { operatesOnEntry: false, allowsRoot: false };

// Strictly under the temp dir, since removing or renaming a temp root would break $TMPDIR for every
// process; mkdir may name the root itself, as it only makes sure it exists.
function isInTmpDir(realPath: string, tmpDir: string, rule: PathRule): boolean {
    return (rule.allowsRoot && realPath === tmpDir) || realPath.startsWith(`${tmpDir}${path.sep}`);
}

function isWithin(candidate: string, dir: string): boolean {
    const relative = path.relative(dir, candidate);
    const leavesDir = relative === '..' || relative.startsWith(`..${path.sep}`);
    return !leavesDir && !path.isAbsolute(relative);
}

// Refuses the project's contents, root and ancestors, since changing an ancestor, such as removing
// it, reaches the project too; a mkdir only finds them there. A temp dir inside it stays writable.
function isWritableNearRoot(realPath: string, projectRoot: string, rule: PathRule): boolean {
    const candidate = comparablePath(realPath);
    const root = comparablePath(projectRoot);
    const holdsProject = isWithin(root, candidate);
    const isInsideProject = !holdsProject && isWithin(candidate, root);
    if (!isInsideProject && (!holdsProject || rule.allowsRoot)) {
        return true;
    }
    return (realTmpDirs ?? []).some((tmpDir) => {
        const comparableTmpDir = comparablePath(tmpDir);
        return (
            comparableTmpDir !== root &&
            isWithin(comparableTmpDir, root) &&
            isInTmpDir(candidate, comparableTmpDir, rule)
        );
    });
}

// macOS and Windows volumes are case-insensitive by default, so a name can reach the project in any
// case; folding refuses too much on a case-sensitive one rather than too little.
const FOLDS_CASE = process.platform === 'darwin' || process.platform === 'win32';
function comparablePath(candidate: string): string {
    return FOLDS_CASE ? candidate.toLowerCase() : candidate;
}

function isWritableUnderV2(realPath: string, projectRoots: readonly string[], rule: PathRule) {
    return projectRoots.every((projectRoot) => isWritableNearRoot(realPath, projectRoot, rule));
}

type PathVerdict = Extract<
    WriteVerdict,
    'permitted' | 'refused' | 'refusedEitherWay' | 'endedRun' | 'uncheckablePath'
>;

function isFallbackRun(scope: BlockedScope): boolean {
    return scope.policy?.runtime === 'v1' && scope.policy.isFallback;
}

function pathVerdict(scope: BlockedScope, value: unknown, rule: PathRule): PathVerdict {
    // Such as a URL or Uint8Array from another realm, which Node still accepts as a path.
    const filePath = toFilePath(value);
    if (filePath === undefined) {
        return 'uncheckablePath';
    }
    const realPath = rule.operatesOnEntry ? realEntryPath(filePath) : realPathForWrite(filePath);
    // macOS resolves /dev/fd/N to /dev/fd/<file name>, which doesn't say where the file is.
    if (realPath === undefined || isWithin(realPath, '/dev/fd')) {
        return 'uncheckablePath';
    }
    const { policy } = scope;
    if (policy?.runtime === 'v2') {
        return isWritableUnderV2(realPath, policy.projectRoots, rule) ? 'permitted' : 'refused';
    }
    if (realTmpDirs?.some((tmpDir) => isInTmpDir(realPath, tmpDir, rule)) !== true) {
        const v2RefusesToo =
            policy !== undefined &&
            isFallbackRun(scope) &&
            !isWritableUnderV2(realPath, policy.projectRoots, rule);
        return v2RefusesToo ? 'refusedEitherWay' : 'refused';
    }
    // A v1 run's detached callbacks stay blocked once it ends; v2's rule doesn't depend on the run.
    return scope.closed ? 'endedRun' : 'permitted';
}

// Which arguments name what a method modifies; every other method modifies its first argument.
const WRITTEN_ARG_INDEXES: Record<string, number[]> = {
    copyFile: [1],
    cp: [1],
    rename: [0, 1],
    link: [0, 1],
    symlink: [1],
};
// Arguments naming a directory entry the method acts on itself rather than through a final symlink.
const ENTRY_ARG_INDEXES: Record<string, number[]> = {
    cp: [1],
    unlink: [0],
    rm: [0],
    rmdir: [0],
    rename: [0, 1],
    link: [1],
    symlink: [1],
    lchmod: [0],
    lchown: [0],
    lutimes: [0],
};
// Refused under v1, so no writable directory holds a link that could redirect a write (cp copies
// symlinks as-is).
const V1_REFUSED_WRITES = new Set(['symlink', 'cp']);
function isRecursiveCopy(options: unknown): boolean {
    if (!isObjectLike(options)) {
        return false;
    }
    const recursive: unknown = Reflect.get(options, 'recursive');
    return Boolean(recursive);
}
// Create `<prefix>XXXXXX`, so that path, not the prefix, must be in a writable directory.
const PREFIX_CREATING_WRITES = new Set(['mkdtemp', 'mkdtempDisposable']);
function pathCreatedFromPrefix(value: unknown): string | undefined {
    const prefix = toFilePath(value);
    return prefix === undefined ? undefined : `${prefix}XXXXXX`;
}
// Data writes to stdout/stderr are console output (e.g. pino's sonic-boom); truncating or
// chmod-ing them is not.
const STDIO_DATA_WRITES = new Set(['write', 'writev', 'writeFile', 'appendFile']);

// Allowed when every modified target is console output, a path under a writable directory, or an
// fd or FileHandle opened there. Worked out once per method, since it runs on every guarded fs call.

function makeWriteVerdict(method: string): (scope: BlockedScope, args: unknown[]) => WriteVerdict {
    const baseMethod = method.replace(/Sync$/, '');
    const refusedUnderV1 = V1_REFUSED_WRITES.has(baseMethod);
    const writtenIndexes = WRITTEN_ARG_INDEXES[baseMethod] ?? [0];
    const entryIndexes = ENTRY_ARG_INDEXES[baseMethod] ?? [];
    const allowsRoot = baseMethod === 'mkdir';
    const allowsStdio = STDIO_DATA_WRITES.has(baseMethod);
    const createsFromPrefix = PREFIX_CREATING_WRITES.has(baseMethod);
    const copiesTree = baseMethod === 'cp';
    const targetVerdict = (scope: BlockedScope, target: unknown, index: number): WriteVerdict => {
        if (allowsStdio && (target === 1 || target === 2)) {
            return 'permitted';
        }
        // Stay writable after the run ends, so a stream it left writing can finish.
        if (typeof target === 'number') {
            return scope.writableFds.has(target) ? 'permitted' : 'uncheckable';
        }
        if (isObjectLike(target) && scope.writableHandles.has(target)) {
            return 'permitted';
        }
        if (isFileHandle(target)) {
            return 'uncheckable';
        }
        const writtenPath = createsFromPrefix ? pathCreatedFromPrefix(target) : target;
        const operatesOnEntry = entryIndexes.includes(index);
        const rule = { operatesOnEntry, allowsRoot };
        return pathVerdict(scope, writtenPath, rule);
    };
    return (scope, args) => {
        const verdicts = writtenIndexes.map((index) => targetVerdict(scope, args[index], index));
        const refusal = verdicts.find((verdict) => verdict !== 'permitted');
        if (refusal !== undefined) {
            return refusal;
        }
        // A recursive cp writes inside its destination unchecked, so a symlink there can lead it
        // into the project.
        const copiesRecursively = copiesTree && isRecursiveCopy(args[2]);
        if (refusedUnderV1 && !followsV2(scope)) {
            return copiesRecursively && isFallbackRun(scope) ? 'linkOrCopyEitherWay' : 'linkOrCopy';
        }
        if (copiesRecursively) {
            return 'recursiveCopy';
        }
        return 'permitted';
    };
}

// A run that ended stays registered while it owns fds, so the fs.close guard still revokes them and
// a reused fd number never inherits write access.
function deregisterIfIdle(scope: BlockedScope): void {
    if (scope.closed && scope.writableFds.size === 0) {
        getOpenScopes().delete(scope);
    }
}

// Re-registers a run that ended while the open was in flight, so the fd can still be revoked.
function recordWritableFd(scope: BlockedScope, fd: number): void {
    scope.writableFds.add(fd);
    getOpenScopes().add(scope);
}

function forgetWritableFd(fd: number): void {
    getOpenScopes().forEach((scope) => {
        scope.writableFds.delete(fd);
        deregisterIfIdle(scope);
    });
}

// Refuses a write outside the writable directories; outside any run, the real function is called
// directly, skipping argument inspection.
function guardFsWriteMethod(method: string, form: FsWriteForm): FsWriteGuard {
    const verdictFor = makeWriteVerdict(method);
    return (getReal) => {
        const refusals = makeFsRefusals(getReal, form);
        const wrapper = function (this: unknown, ...args: unknown[]): unknown {
            const scope = getBlockedContext().current();
            const verdict = scope === undefined ? 'permitted' : verdictFor(scope, args);
            const callTarget = verdict === 'permitted' ? getReal() : refusals[verdict];
            return Reflect.apply(callTarget, this, args);
        };
        const real = getReal();
        copyPromisifyMetadata(real, wrapper);
        return wrapper;
    };
}

// Records each fd opened for writing in a writable directory, so fd-based writes on it (including
// createWriteStream's) are allowed; any other write-mode open is refused before it can truncate.
function guardFsOpenMethod(mode: 'sync' | 'callback'): FsWriteGuard {
    return (getReal) => {
        const refusals = makeFsRefusals(getReal, mode);
        return function (this: unknown, ...args: unknown[]): unknown {
            const real = getReal();
            const scope = getBlockedContext().current();
            if (scope === undefined || !opensForWriting(args)) {
                return Reflect.apply(real, this, args);
            }
            const verdict = pathVerdict(scope, args[0], WRITE_THROUGH_PATH);
            if (verdict !== 'permitted') {
                return Reflect.apply(refusals[verdict], this, args);
            }
            if (mode === 'sync') {
                const fd: unknown = Reflect.apply(real, this, args);
                if (typeof fd === 'number') {
                    recordWritableFd(scope, fd);
                }
                return fd;
            }
            const callback = args[args.length - 1];
            if (typeof callback !== 'function') {
                return Reflect.apply(real, this, args);
            }
            // Recorded even if the run ended meanwhile, since the caller, such as a stream, owns the fd.
            const recordFd = (err: unknown, fd: unknown) => {
                if (!err && typeof fd === 'number') {
                    recordWritableFd(scope, fd);
                }
                Reflect.apply(callback, undefined, [err, fd]);
            };
            const argsWithRecorder = [...args.slice(0, -1), recordFd];
            return Reflect.apply(real, this, argsWithRecorder);
        };
    };
}

// Forgets a closed fd in every run, wherever it's closed from, so a later file the OS gives the
// same number doesn't inherit write access.
const guardFsCloseMethod: FsWriteGuard = (getReal) =>
    function (this: unknown, ...args: unknown[]): unknown {
        const fd = args[0];
        if (typeof fd === 'number') {
            forgetWritableFd(fd);
        }
        const real = getReal();
        return Reflect.apply(real, this, args);
    };

// readFile opens a path itself rather than through fs.open, so a write flag in its options can
// truncate or create the file. Node ignores the flag for an fd or FileHandle.
function readsPathForWriting(args: unknown[]): boolean {
    const [target, options] = args;
    const isPath = typeof target !== 'number' && !isFileHandle(target);
    const flag: unknown = isObjectLike(options) ? Reflect.get(options, 'flag') : undefined;
    return isPath && opensForWriting([target, flag]);
}

function guardFsReadFileMethod(form: FsWriteForm): FsWriteGuard {
    return (getReal) => {
        const refusals = makeFsRefusals(getReal, form);
        const wrapper = function (this: unknown, ...args: unknown[]): unknown {
            const scope = getBlockedContext().current();
            const verdict =
                scope !== undefined && readsPathForWriting(args)
                    ? pathVerdict(scope, args[0], WRITE_THROUGH_PATH)
                    : 'permitted';
            const callTarget = verdict === 'permitted' ? getReal() : refusals[verdict];
            return Reflect.apply(callTarget, this, args);
        };
        const real = getReal();
        copyPromisifyMetadata(real, wrapper);
        return wrapper;
    };
}

// Each async name is guarded on fs (callback form) and fs.promises (promise form); the installer
// skips a name a module doesn't expose. fs.promises and require('fs/promises') are the same object.
const FS_SYNC_WRITE_METHODS = [
    'writeFileSync',
    'appendFileSync',
    'writeSync',
    'writevSync',
    'copyFileSync',
    'unlinkSync',
    'rmSync',
    'rmdirSync',
    'renameSync',
    'mkdirSync',
    'symlinkSync',
    'linkSync',
    'cpSync',
    'truncateSync',
    'ftruncateSync',
    'mkdtempSync',
    'mkdtempDisposableSync',
    'utimesSync',
    'futimesSync',
    'lutimesSync',
    'chmodSync',
    'fchmodSync',
    'lchmodSync',
    'chownSync',
    'fchownSync',
    'lchownSync',
];
const FS_ASYNC_WRITE_METHODS = FS_SYNC_WRITE_METHODS.map((method) => method.replace(/Sync$/, ''));
const FS_WRITE_GUARD_INSTALLS: Array<[target: object, methods: string[], form: FsWriteForm]> = [
    [fs, FS_SYNC_WRITE_METHODS, 'sync'],
    [fs, FS_ASYNC_WRITE_METHODS, 'callback'],
    [fs.promises, FS_ASYNC_WRITE_METHODS, 'promise'],
];
type PromisesOpen = typeof fs.promises.open;

// A write-mode open is refused where writes aren't permitted; otherwise the handle and its fd are
// recorded, and the fd is revoked when the handle closes.
// A FileHandle's close is an own property of each handle and skips fs.close, so it's wrapped here.
function revokeFdOnClose(handle: fs.promises.FileHandle): void {
    const { fd } = handle;
    const realClose = handle.close;
    handle.close = function close(this: unknown, ...args: unknown[]) {
        forgetWritableFd(fd);
        return Reflect.apply(realClose, this, args);
    };
}

function guardReturnedHandle(handle: fs.promises.FileHandle): fs.promises.FileHandle {
    guardFileHandlePrototype(handle);
    return handle;
}

function guardPromisesOpen(real: PromisesOpen): PromisesOpen {
    const refusals = makeFsRefusals(() => real, 'promise');
    function open(this: unknown, ...args: Parameters<PromisesOpen>): ReturnType<PromisesOpen> {
        if (!opensForWriting(args)) {
            const reading: ReturnType<PromisesOpen> = Reflect.apply(real, this, args);
            return fileHandlePrototype === undefined ? reading.then(guardReturnedHandle) : reading;
        }
        const scope = getBlockedContext().current();
        if (scope === undefined) {
            return Reflect.apply(real, this, args);
        }
        const verdict = pathVerdict(scope, args[0], WRITE_THROUGH_PATH);
        if (verdict !== 'permitted') {
            return Reflect.apply(refusals[verdict], this, args);
        }
        const opening: ReturnType<PromisesOpen> = Reflect.apply(real, this, args);
        return opening.then((handle) => {
            scope.writableHandles.add(handle);
            recordWritableFd(scope, handle.fd);
            revokeFdOnClose(handle);
            return guardReturnedHandle(handle);
        });
    }
    Object.defineProperty(open, GUARD_GENERATION, { value: true });
    return open;
}

// A handle's own modifying methods skip the fs guards, and chmod/chown/utimes work even on a
// read-mode handle, so inside a run they only work on a handle opened for writing where allowed.
const FILE_HANDLE_WRITE_METHODS = [
    'appendFile',
    'chmod',
    'chown',
    'truncate',
    'utimes',
    'write',
    'writeFile',
    'writev',
];

let fileHandlePrototype: object | undefined;
// A patched open answering the null-device probe with a plain object leaves no FileHandle to guard
// until a real one comes back, so runs proceed.
let probeFoundNoFileHandle = false;
function fileHandleGuardReady(): boolean {
    return fileHandlePrototype !== undefined || probeFoundNoFileHandle;
}

function isFileHandle(value: unknown): boolean {
    return (
        fileHandlePrototype !== undefined &&
        isObjectLike(value) &&
        Object.prototype.isPrototypeOf.call(fileHandlePrototype, value)
    );
}

// A plain object's prototype would make every object count as a FileHandle.
function isFileHandlePrototype(prototype: unknown): prototype is object {
    if (!isObjectLike(prototype) || prototype === Object.prototype) {
        return false;
    }
    return FILE_HANDLE_WRITE_METHODS.every((method) => {
        const candidate: unknown = Reflect.get(prototype, method);
        return isFunction(candidate);
    });
}

function guardFileHandlePrototype(handle: object): void {
    const prototype: unknown = Object.getPrototypeOf(handle);
    if (fileHandlePrototype !== undefined || !isFileHandlePrototype(prototype)) {
        return;
    }
    fileHandlePrototype = prototype;
    for (const method of FILE_HANDLE_WRITE_METHODS) {
        const real: unknown = Reflect.get(prototype, method);
        if (!isFunction(real) || Reflect.get(real, GUARD_GENERATION) === true) {
            continue;
        }
        const refuse = makeFsRefusal(() => real, 'promise', 'uncheckable');
        const guarded = function (this: unknown, ...args: unknown[]): unknown {
            const scope = getBlockedContext().current();
            const writable = isObjectLike(this) && scope?.writableHandles.has(this) === true;
            const callTarget = scope === undefined || writable ? real : refuse;
            return Reflect.apply(callTarget, this, args);
        };
        Object.defineProperty(guarded, GUARD_GENERATION, { value: true });
        Reflect.set(prototype, method, guarded);
    }
}

// FileHandle isn't exported, so its prototype comes from a handle on the null device, opened at
// install; the open guard also applies it to the first handle it returns, if that comes sooner.
let fileHandleGuard: Promise<void> | undefined;
function startGuardingFileHandles(): void {
    fileHandleGuard ??= fs.promises
        .open(os.devNull, 'r')
        .then(async (handle) => {
            guardFileHandlePrototype(handle);
            probeFoundNoFileHandle = fileHandlePrototype === undefined;
            await handle.close();
        })
        .catch(() => {
            // Retried on the next install, like any other guard that failed to install.
            fileHandleGuard = undefined;
        });
}

// A plain data property, unlike the accessors above, so other packages' tests can still
// jest.spyOn(fs.promises, 'open'). A reassignment can drop it, so every install re-wraps the current
// value unless it's already this guard; a spy around the guard just gets wrapped once more.
function installPromisesOpenGuard(): void {
    const current = fs.promises.open;
    if (typeof current === 'function' && Reflect.get(current, GUARD_GENERATION) !== true) {
        fs.promises.open = guardPromisesOpen(current);
    }
}

function installFsGuards(): void {
    installPromisesOpenGuard();
    installGuardedProperty<FsWriteFn>(fs, 'open', guardFsOpenMethod('callback'));
    installGuardedProperty<FsWriteFn>(fs, 'openSync', guardFsOpenMethod('sync'));
    installGuardedProperty<FsWriteFn>(fs, 'close', guardFsCloseMethod);
    installGuardedProperty<FsWriteFn>(fs, 'closeSync', guardFsCloseMethod);
    installGuardedProperty<FsWriteFn>(fs, 'readFileSync', guardFsReadFileMethod('sync'));
    installGuardedProperty<FsWriteFn>(fs, 'readFile', guardFsReadFileMethod('callback'));
    installGuardedProperty<FsWriteFn>(fs.promises, 'readFile', guardFsReadFileMethod('promise'));
    for (const [target, methods, form] of FS_WRITE_GUARD_INSTALLS) {
        for (const method of methods) {
            const guard = guardFsWriteMethod(method, form);
            installGuardedProperty<FsWriteFn>(target, method, guard);
        }
    }
    realTmpDirs ??= captureRealTmpDirs();
}

// graceful-fs publishes its queue on the real fs when it loads; a clone it (or fs-extra) made before
// the install copied fs's original functions, so writes through it skip the guards.
const GRACEFUL_FS_QUEUE = Symbol.for('graceful-fs.queue');
let gracefulFsLoadedFirst = false;

export const GRACEFUL_FS_UNGUARDED_WARNING =
    'fs-extra or graceful-fs was loaded before the dev server installed the local-execution guards, so filesystem writes a backend function makes through it are not blocked.';

export function gracefulFsPredatesGuards(): boolean {
    return gracefulFsLoadedFirst;
}

let guardsInstalled = false;
// Patches process-wide built-ins, so it's called explicitly (by the Vite dev server and before
// each local execution) rather than at import: every bundler that loads this plugin imports this file.
export function installGuards(): void {
    if (guardsInstalled) {
        installPromisesOpenGuard();
        startGuardingFileHandles();
        return;
    }
    gracefulFsLoadedFirst ||= Object.prototype.hasOwnProperty.call(fs, GRACEFUL_FS_QUEUE);
    // Each property install is a no-op once done, so a call after a failed attempt retries the rest.
    installSubprocessGuards();
    installFsGuards();
    // Node keeps ESM named bindings (`import { spawn } from 'node:child_process'`) as separate
    // references to the original values until this re-syncs them with the patched CJS exports.
    syncBuiltinESMExports();
    startGuardingFileHandles();
    guardsInstalled = true;
}

// Captured at load, since Jest's fake timers replace process.nextTick and would stall a run's close.
const { nextTick } = process;

// Runs `fn` outside any run's blocked scope — for work done on a run's behalf that isn't customer
// code, like Vite resolving and transforming a module the run dynamically imports.
export function runOutsideBlockedScope<T>(fn: () => T): T {
    return getBlockedContext().exit(fn);
}

export const NON_STRING_MODULE_ID_MESSAGE = 'Module id must be a string';

// Vite and its plugins call methods on the id, so a customer object's own toString or startsWith
// would otherwise run exempt. Vite's methods are async, so a rejection matches how they fail on one.
function runExemptForStringId<T>(id: unknown, call: () => Promise<T>): Promise<T> {
    if (typeof id !== 'string') {
        const idError = new TypeError(NON_STRING_MODULE_ID_MESSAGE);
        return Promise.reject(idError);
    }
    return runOutsideBlockedScope(call);
}

// Wraps Vite's module fetch (resolve, load, transform) so project plugins doing that work for a
// run's dynamic import aren't blocked; evaluating the fetched module still runs in the run's scope.
export function exemptFetchFromBlockedScope<Rest extends unknown[], Result>(
    fetchModule: (id: string, ...rest: Rest) => Promise<Result>,
): (id: string, ...rest: Rest) => Promise<Result> {
    return (id, ...rest) => runExemptForStringId(id, () => fetchModule(id, ...rest));
}

// Vite 5 has no environment API; its module fetch calls these container methods, looked up per call.
const PLUGIN_CONTAINER_ID_ARG_INDEXES: Record<string, number> = {
    resolveId: 0,
    load: 0,
    transform: 1,
};

export function exemptPluginContainerFromBlockedScope(container: object): void {
    for (const [method, idIndex] of Object.entries(PLUGIN_CONTAINER_ID_ARG_INDEXES)) {
        const original: unknown = Reflect.get(container, method);
        if (typeof original !== 'function') {
            continue;
        }
        const exempt = function (this: unknown, ...args: unknown[]): Promise<unknown> {
            return runExemptForStringId(args[idIndex], () => Reflect.apply(original, this, args));
        };
        Reflect.set(container, method, exempt);
    }
}

function closeScope(scope: BlockedScope): void {
    scope.closed = true;
    deregisterIfIdle(scope);
}

// Compared by real path, as the writes are; a missing directory still names where it would be. The
// configured path is kept too, so a symlink among its ancestors can't be removed or replaced.
function projectRootsFor(projectRoot: string): string[] {
    const configuredRoot = path.resolve(projectRoot);
    const realRoot = realPathForWrite(projectRoot) ?? configuredRoot;
    return [...new Set([realRoot, configuredRoot])];
}

// v2 needs the project directory it protects, so without one a run keeps v1's blocks.
function policyFor(runtime: unknown, projectRoot: unknown, isFallbackRuntime: unknown): RunPolicy {
    if (runtime === 'v2' && typeof projectRoot === 'string' && projectRoot !== '') {
        return { runtime: 'v2', projectRoots: projectRootsFor(projectRoot) };
    }
    const isFallback = runtime === 'v1' && isFallbackRuntime === true;
    const roots = isFallback && typeof projectRoot === 'string' && projectRoot !== '';
    return { runtime: 'v1', isFallback, projectRoots: roots ? projectRootsFor(projectRoot) : [] };
}

// Runs `fn` under its runtime's blocks; wraps the customer's function body in `local-execution.ts`'s
// `runScriptLocally`. Aborting `signal` closes the scope, which under v1 refuses later writes from a
// `fn` its caller gave up on.
export async function runBlocked<T>(
    fn: () => Promise<T>,
    options: {
        signal?: AbortSignal;
        runtime?: BackendRuntime;
        isFallbackRuntime?: boolean;
        projectRoot?: string;
    } = {},
): Promise<T> {
    if (options.signal?.aborted) {
        throw new Error('The run was aborted before it started.');
    }
    installGuards();
    assertNoForeignGuard();
    // A FileHandle opened before install stays unguarded until the async prototype guard lands, so
    // only a cold install waits; afterwards fn still starts synchronously.
    if (!fileHandleGuardReady()) {
        await fileHandleGuard;
        if (!fileHandleGuardReady()) {
            throw new Error(FILE_HANDLE_GUARD_UNAVAILABLE_MESSAGE);
        }
        if (options.signal?.aborted) {
            throw new Error('The run was aborted before it started.');
        }
    }
    const policy = policyFor(options.runtime, options.projectRoot, options.isFallbackRuntime);
    if (policy.runtime === 'v2' && olderGuardFound) {
        throw new Error(OLDER_GUARD_MESSAGE);
    }
    const scope: BlockedScope = {
        writableFds: new Set(),
        writableHandles: new WeakSet(),
        policy,
        closed: false,
    };
    getOpenScopes().add(scope);
    const onAbort = () => closeScope(scope);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        return await getBlockedContext().run(scope, fn);
    } finally {
        options.signal?.removeEventListener('abort', onAbort);
        // Work fn queued for the next tick, like a write stream's open, still starts in the run.
        await new Promise((resolve) => {
            nextTick(resolve);
        });
        closeScope(scope);
    }
}
