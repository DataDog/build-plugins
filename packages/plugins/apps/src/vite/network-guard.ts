// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis, Proxy */

import child_process from 'child_process';
import dgram from 'dgram';
import dns from 'dns';
import net from 'net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import worker_threads from 'worker_threads';

import { createEpochGuard } from './execution-epoch';
import { makeGuardWrapper } from './guarded-wrapper';
import { getOrCreateShared } from './shared-module-singleton';

// No OS sandbox here (unlike prod's Deno) — blocks net/subprocess at the JS level, scoped per-call via AsyncLocalStorage, not a global toggle.

const NETWORK_BLOCKED_MESSAGE =
    'Network access is not allowed directly in backend functions — use $.Actions instead.';
const SUBPROCESS_BLOCKED_MESSAGE = 'Spawning a subprocess is not allowed in backend functions.';
const WORKER_THREAD_BLOCKED_MESSAGE =
    'Spawning a worker thread is not allowed in backend functions.';

// Keyed on the real `net` module (not a per-module `new AsyncLocalStorage()`) since this file gets
// evaluated more than once — bundled copies and Jest's per-test-file isolation — and every
// evaluation needs the same store. `globalThis`/`process` are sandboxed per test file too; core
// modules aren't. isCurrentlyBlocked() is every guard's shared gate.
function getSharedContext(key: string): AsyncLocalStorage<true> {
    return getOrCreateShared(
        net,
        `@dd/apps-plugin/network-guard ${key}`,
        () => new AsyncLocalStorage<true>(),
    );
}

// Scoped to the active `runBlocked` call's async chain, not process-wide, so unrelated concurrent callers aren't blocked too.
const blockedContext = getSharedContext('blockedContext');

// Scoped to the active `runAllowed` call's async chain, not process-wide, so a sibling call stays blocked during the exemption.
const allowedContext = getSharedContext('allowedContext');

function isCurrentlyBlocked(): boolean {
    return blockedContext.getStore() === true && allowedContext.getStore() !== true;
}

// `Symbol.for`, not `Symbol()`, so every re-evaluation of this file recognizes an already-installed guard instead of minting its own.
const ALREADY_GUARDED = Symbol.for('@dd/apps-plugin/network-guard installed');

// Jest's globalThis Proxy can't produce a non-configurable property without throwing, and by then
// it's already mutated the real object — so relax configurability under Jest (detected via this
// env var) instead of hitting that failure. Production never sets it.
const RUNNING_UNDER_JEST = process.env.JEST_WORKER_ID !== undefined;

// Module objects (net/dgram/dns) stay non-configurable even under Jest, or dd-trace's CI
// Visibility instrumentation could swap in its own unguarded function. globalThis is relaxed so
// Jest's environment can still touch it. write/end need their own carve-out: CI pipes
// stdout/stderr into real net.Socket instances, and jest-mock's spyOn/restoreMock needs
// `configurable` to restore them.
function shouldAllowConfigurableUnderJest(target: object, prop: string): boolean {
    if (!RUNNING_UNDER_JEST) {
        return false;
    }
    return (
        target === globalThis ||
        (target === net.Socket.prototype && (prop === 'write' || prop === 'end'))
    );
}

/**
 * Permanent getter/setter — a detached callback can still fire after `runBlocked` resolves and
 * must stay blocked. The setter rebuilds the guard on every write since some libraries (e.g. MSW)
 * mark the last function object they saw as "already patched," and reusing one frozen object
 * collides. Non-configurable except `globalThis` under Jest (see `shouldAllowConfigurableUnderJest`),
 * so a dependency can't swap the whole descriptor; plain reassignment still works. Re-installing on
 * an already-guarded property is a no-op via `ALREADY_GUARDED`.
 */
export function installGuardedProperty<T>(
    target: object,
    prop: string,
    makeGuard: (getReal: () => T) => T,
): void {
    const existingGetter = Object.getOwnPropertyDescriptor(target, prop)?.get as
        | { [ALREADY_GUARDED]?: true }
        | undefined;
    if (existingGetter?.[ALREADY_GUARDED]) {
        return;
    }

    let real = (target as Record<string, T>)[prop];
    if (real === undefined) {
        // Nothing to guard — this runtime doesn't expose this method/global (e.g. dns.resolveTlsa
        // on Node 20). A wrapper here would make feature-detection lie.
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
        const guard = makeGuard(() => capturedReal);
        // WeakMap.set() throws on a non-object key; makeGuard can return one (e.g. guardWebSocket
        // returns undefined when the real global doesn't exist).
        if (guard !== null && (typeof guard === 'object' || typeof guard === 'function')) {
            realAtGuardCreation.set(guard as object, real);
        }
        return guard;
    }

    let currentGuard = buildGuard();
    const getter = (): T => currentGuard;
    (getter as unknown as { [ALREADY_GUARDED]: true })[ALREADY_GUARDED] = true;
    Object.defineProperty(target, prop, {
        configurable: shouldAllowConfigurableUnderJest(target, prop),
        enumerable: true,
        get: getter,
        // A plain `function`, not an arrow, so `this` is the real receiver — needed to tell
        // `net.Socket.prototype.write = mock` (every socket) apart from `someSocket.write = mock`
        // (one socket) when `target` is a shared prototype.
        set: function (this: unknown, value: T) {
            if (
                this !== target &&
                this !== null &&
                (typeof this === 'object' || typeof this === 'function')
            ) {
                // `target` is a shared prototype — shadow the guard on this instance only, like an
                // unguarded assignment would, instead of repointing the delegate every other
                // instance's guard calls through. Some Node/Jest internals call this setter with a
                // non-object receiver; fall through to the shared-delegate path for those.
                Object.defineProperty(this, prop, {
                    value,
                    writable: true,
                    configurable: true,
                    enumerable: true,
                });
                return;
            }
            real = realAtGuardCreation.has(value as object)
                ? (realAtGuardCreation.get(value as object) as T)
                : value;
            currentGuard = buildGuard();
        },
    });
}

// write/end signal failure by erroring/destroying the stream, not throwing — a synchronous throw
// would surface as an uncaught exception in Node internals that call write() without a try/catch
// (e.g. http's request-flush code, the exact path a reused keep-alive socket takes). destroy() is
// only safe when something listens for 'error' — Node's default for an unlistened 'error' is to
// crash the process. A completion callback is always invoked either way.
function isFunction(value: unknown): value is (...args: unknown[]) => void {
    return typeof value === 'function';
}

// Node's error-first callback is always the last argument. Shared by signalBlockedSocketOp,
// guardCallbackMethod, and guardExecFactory. Returns whether one was found, so a caller can fall
// back to an 'error' event.
function invokeCallbackArg(args: unknown[], err: Error, ...extraArgs: unknown[]): boolean {
    const maybeCallback = args[args.length - 1];
    if (isFunction(maybeCallback)) {
        process.nextTick(maybeCallback, err, ...extraArgs);
        return true;
    }
    return false;
}

// Deferred via process.nextTick so a listener attached right after the call still sees it,
// matching a real socket's error-emission timing. Shared by guardBindMethod,
// guardCallbackMethod's EventEmitter fallback, guardChildProcessSpawnMethod, and
// createBlockedChildProcessStub.
function emitAsyncErrorIfListened(target: EventEmitter, err: Error): void {
    process.nextTick(() => {
        if (target.listenerCount('error') > 0) {
            target.emit('error', err);
        }
    });
}

function signalBlockedSocketOp(socket: net.Socket, args: unknown[]): void {
    const err = new Error(NETWORK_BLOCKED_MESSAGE);
    invokeCallbackArg(args, err);
    // Deferred to match a real socket's error timing — checking listenerCount synchronously here
    // would miss a listener attached on the next line.
    process.nextTick(() => {
        if (socket.listenerCount('error') > 0) {
            socket.destroy(err);
        }
    });
}

// The dev server's own stdout/stderr are real net.Socket instances whenever the process is piped —
// not a network-exfiltration vector, so exempting them only saves the developer's console.log
// during a blocked scope. Captured once at module load, which local-execution.ts's
// loadCustomerModuleEntry always awaits before evaluating any customer module's top-level code, so
// this can never capture a value a customer module already repointed via
// `Object.defineProperty(process, 'stdout', ...)` — the live `process.stdout`/`stderr` getters are
// reassignable, and a customer function could otherwise repoint them at an attacker-controlled
// socket to exfiltrate past the block.
const trustedStdout: unknown = process.stdout;
const trustedStderr: unknown = process.stderr;
function isProcessStdio(socket: net.Socket): boolean {
    return socket === trustedStdout || socket === trustedStderr;
}

// Same reasoning as trustedStdout/trustedStderr above, captured before installGuardedProperty
// patches `globalThis.fetch` below: the dev server's own authenticated request (packages/core's
// request.ts, used for $.Actions calls and runtime-context hydration) must reach the real network
// stack even if a customer function already reassigned `globalThis.fetch` to an attacker-controlled
// wrapper before triggering that call — a plain reassignment goes through installGuardedProperty's
// setter and rewrites the guard's own delegate, which the authenticated request would otherwise call
// through to while inside runAllowed. Callers that need this must be threaded explicitly (e.g. via
// RequestOpts.fetchImpl) rather than relying on a fresh `globalThis.fetch` lookup at call time.
export const trustedFetch: typeof fetch = globalThis.fetch;

// Shared by guardSocketWrite/guardSocketEnd, which differ only in the blocked-path return value
// (write() returns a boolean, end() returns `this` for chaining).
function guardSocketOp<R>(
    getReal: () => (this: net.Socket, ...args: never[]) => R,
    blockedReturn: (socket: net.Socket) => R,
): (this: net.Socket, ...args: never[]) => R {
    const wrapper = function (this: net.Socket, ...args: unknown[]): R {
        if (!isCurrentlyBlocked() || isProcessStdio(this)) {
            return (getReal() as unknown as (...a: unknown[]) => R).apply(this, args);
        }
        signalBlockedSocketOp(this, args);
        return blockedReturn(this);
    };
    return wrapper as unknown as (this: net.Socket, ...args: never[]) => R;
}

function guardSocketWrite<F extends (this: net.Socket, ...args: never[]) => boolean>(
    getReal: () => F,
): F {
    return guardSocketOp<boolean>(getReal, () => false) as unknown as F;
}

// Same as guardSocketWrite, but end() returns `this` for chaining.
function guardSocketEnd<F extends (this: net.Socket, ...args: never[]) => net.Socket>(
    getReal: () => F,
): F {
    return guardSocketOp<net.Socket>(getReal, (socket) => socket) as unknown as F;
}

// net.Server.listen/dgram.Socket.bind/connect: their optional callback is a success-only shorthand
// for the 'listening'/'connect' event (no error parameter per @types/node) — real failures only
// ever reach the async 'error' event, so a synchronous throw here would surface as an uncaught
// exception in the idiomatic `server.on('error', cb); server.listen(port)` pattern. Deferred via
// process.nextTick for the same same-tick-safety reason as signalBlockedSocketOp.
function guardBindMethod<F extends (this: EventEmitter, ...args: never[]) => unknown>(
    getReal: () => F,
): F {
    const wrapper = function (this: EventEmitter, ...args: unknown[]): unknown {
        if (!isCurrentlyBlocked()) {
            return (getReal() as unknown as (...a: unknown[]) => unknown).apply(this, args);
        }
        emitAsyncErrorIfListened(this, new Error(NETWORK_BLOCKED_MESSAGE));
        return this;
    };
    return wrapper as unknown as F;
}

// dgram.Socket.send and the callback-style dns.resolve* surfaces report failure via an error-first
// callback (dns.resolve*'s is mandatory, dgram's optional, falling back to an async 'error' event).
// Deferred via process.nextTick for the same reason as guardBindMethod.
function guardCallbackMethod<F extends (...args: never[]) => unknown>(getReal: () => F): F {
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        if (!isCurrentlyBlocked()) {
            return (getReal() as unknown as (...a: unknown[]) => unknown).apply(this, args);
        }
        const err = new Error(NETWORK_BLOCKED_MESSAGE);
        if (!invokeCallbackArg(args, err) && this instanceof EventEmitter) {
            emitAsyncErrorIfListened(this, err);
        }
        return undefined;
    };
    return wrapper as unknown as F;
}

// dns.promises.*/dns.promises.Resolver.prototype.* always return a Promise, so a `.catch()`-chaining
// caller needs a rejection, not a thrown exception.
function guardNetworkPromiseMethod<F extends (...args: never[]) => Promise<unknown>>(
    getReal: () => F,
): F {
    return makeGuardWrapper(getReal, () => isCurrentlyBlocked(), NETWORK_BLOCKED_MESSAGE, 'reject');
}

// Shared by guardWebSocket/guardEventSource/guardWorker. A Proxy construct trap, not a subclass,
// so a runtime swap via installGuardedProperty's setter is picked up on the next `new`. Forwards
// the caller's real `newTarget` into Reflect.construct so subclassing (`class Foo extends
// WebSocket {}`) still works instead of always producing a base instance.
function guardConstructibleGlobal(
    getReal: () => unknown,
    blockedMessage: string = NETWORK_BLOCKED_MESSAGE,
): unknown {
    const real = getReal();
    if (real === undefined) {
        // This repo's supported Node range spans versions where these globals don't exist yet.
        return undefined;
    }
    return new Proxy(real as object, {
        construct(_target, args, newTarget) {
            if (isCurrentlyBlocked()) {
                throw new Error(blockedMessage);
            }
            const RealCtor = getReal() as new (...a: unknown[]) => object;
            return Reflect.construct(RealCtor, args, newTarget);
        },
    });
}

export function guardWebSocket(getReal: () => unknown): unknown {
    return guardConstructibleGlobal(getReal);
}

// EventSource's transport bypasses the patched net.Socket.connect the same way WebSocket does.
// Not reachable without --experimental-eventsource on this repo's Node versions, but guarding it
// unconditionally means it's already correct once a runtime exposes it.
export function guardEventSource(getReal: () => unknown): unknown {
    return guardConstructibleGlobal(getReal);
}

// A worker gets a fresh V8 realm with its own module registry, so nothing inside it inherits this
// file's monkeypatches — blocking construction is the only enforceable boundary.
export function guardWorker(getReal: () => unknown): unknown {
    return guardConstructibleGlobal(getReal, WORKER_THREAD_BLOCKED_MESSAGE);
}

// execSync/execFileSync genuinely throw synchronously on failure — this guard is for those two
// only. The rest have their own guards below matching each one's real (never-throws) contract.
function guardSubprocess<F extends (...args: never[]) => unknown>(getReal: () => F): F {
    return makeGuardWrapper(
        getReal,
        () => isCurrentlyBlocked(),
        SUBPROCESS_BLOCKED_MESSAGE,
        'throw',
    );
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
        if (!isCurrentlyBlocked()) {
            return (getReal() as unknown as (...a: unknown[]) => unknown).apply(this, args);
        }
        return createBlockedChildProcessStub(new Error(SUBPROCESS_BLOCKED_MESSAGE));
    };
    return wrapper as unknown as F;
}

// exec/execFile report failure via an error-first callback and always return a ChildProcess
// synchronously. Real Node sets stdout/stderr to empty strings, not undefined, even on a launch
// failure — a caller doing `err.stderr.trim()` would otherwise TypeError.
function guardExecFactory<F extends (...args: never[]) => unknown>(getReal: () => F): F {
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        if (!isCurrentlyBlocked()) {
            return (getReal() as unknown as (...a: unknown[]) => unknown).apply(this, args);
        }
        const err = new Error(SUBPROCESS_BLOCKED_MESSAGE);
        invokeCallbackArg(args, err, '', '');
        return createBlockedChildProcessStub(err);
    };
    return wrapper as unknown as F;
}

// ChildProcess.prototype.spawn() configures an existing instance, so there's no factory return
// value to fabricate — just this instance's async 'error' event. The real method returns a
// synchronous integer (0 success, negative errno on failure), so the blocked path returns a
// negative placeholder. Kept separate from guardBindMethod since this method's `this` type isn't
// part of @types/node's public surface (see the childProcessPrototype cast below).
function guardChildProcessSpawnMethod<F extends (...args: never[]) => unknown>(
    getReal: () => F,
): F {
    const wrapper = function (this: EventEmitter, ...args: unknown[]): unknown {
        if (!isCurrentlyBlocked()) {
            return (getReal() as unknown as (...a: unknown[]) => unknown).apply(this, args);
        }
        emitAsyncErrorIfListened(this, new Error(SUBPROCESS_BLOCKED_MESSAGE));
        return -1;
    };
    return wrapper as unknown as F;
}

// spawnSync never throws either — it returns a SpawnSyncReturns-shaped object with `.error` set,
// so the guard mirrors that shape. `output` is null on a real launch failure, not an array — a
// caller doing `result.output[1].toString()` would otherwise TypeError against a naive stub.
function guardSpawnSyncResult<F extends (...args: never[]) => unknown>(getReal: () => F): F {
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        if (!isCurrentlyBlocked()) {
            return (getReal() as unknown as (...a: unknown[]) => unknown).apply(this, args);
        }
        return {
            pid: 0,
            output: null,
            stdout: undefined,
            stderr: undefined,
            status: null,
            signal: null,
            error: new Error(SUBPROCESS_BLOCKED_MESSAGE),
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

// net.Socket.connect() genuinely throws synchronously for some argument-validation failures, and
// runs inside the customer function's own async call stack (see runBlocked in local-execution.ts),
// where a synchronous throw is safely caught — unlike the detached-callback guards below, left
// throw-based deliberately.
installGuardedProperty<typeof net.Socket.prototype.connect>(
    net.Socket.prototype,
    'connect',
    (getReal) =>
        makeGuardWrapper(getReal, () => isCurrentlyBlocked(), NETWORK_BLOCKED_MESSAGE, 'throw'),
);
// A reused, already-connected keep-alive socket never calls connect() again for a second request —
// write()/end() are the choke point every request still goes through, so guarding only connect()
// would let a module-load-time "warm-up" request bypass the guard when reused later.
installGuardedProperty<typeof net.Socket.prototype.write>(
    net.Socket.prototype,
    'write',
    guardSocketWrite,
);
installGuardedProperty<typeof net.Socket.prototype.end>(
    net.Socket.prototype,
    'end',
    guardSocketEnd,
);
// A dependency calling `Writable.prototype.write.call(aSocket, data)` directly still reaches the
// real implementation, since only Socket's own write/end are shadowed above. Guarding
// `stream.Writable.prototype` itself isn't viable: countless unrelated Writable subclasses each do
// `SomeClass.prototype.write = ownImpl`, and every such assignment walks up and triggers the same
// inherited setter on Writable.prototype, corrupting every other subclass's write() with whichever
// wrote last (breaks Vite's own HTTP client in real bundler tests). Accepted as a residual gap —
// this guard is dev-time safety, not a hard security boundary (see the "No OS sandbox" note above).
installGuardedProperty<typeof fetch>(globalThis, 'fetch', guardNetworkPromiseMethod);
// dgram (UDP) and the native WebSocket global are separate entry points from fetch/net — neither
// goes through net.Socket, so they need their own guards.
installGuardedProperty<typeof dgram.Socket.prototype.send>(
    dgram.Socket.prototype,
    'send',
    guardCallbackMethod,
);
installGuardedProperty<typeof dgram.Socket.prototype.connect>(
    dgram.Socket.prototype,
    'connect',
    guardBindMethod,
);
// Inbound listeners are a separate entry point from the outbound send/connect above — a dependency
// can still open a real listening socket via net.createServer().listen(...) or dgram's .bind(...).
installGuardedProperty<typeof net.Server.prototype.listen>(
    net.Server.prototype,
    'listen',
    guardBindMethod,
);
installGuardedProperty<typeof dgram.Socket.prototype.bind>(
    dgram.Socket.prototype,
    'bind',
    guardBindMethod,
);
installGuardedProperty<unknown>(globalThis, 'WebSocket', guardWebSocket);
installGuardedProperty<unknown>(globalThis, 'EventSource', guardEventSource);

// dns.resolve*/dns.promises.resolve*/dns.Resolver/dns.promises.Resolver go through Node's native
// c-ares channel, bypassing the net.Socket/dgram.Socket guards above — each is a distinct function
// object needing its own guard. dns.lookup is deliberately excluded: this threat model is dev-loop
// safety, not DNS-tunneling exfiltration, and guarding it risks breaking hostname validation.
const DNS_RESOLVE_METHODS = [
    'resolve',
    'resolve4',
    'resolve6',
    'resolveAny',
    'resolveCaa',
    'resolveCname',
    'resolveMx',
    'resolveNaptr',
    'resolveNs',
    'resolvePtr',
    'resolveSoa',
    'resolveSrv',
    'resolveTlsa',
    'resolveTxt',
    'reverse',
] as const;
for (const method of DNS_RESOLVE_METHODS) {
    // Each method's real signature differs, so the type argument is pinned to the guard's own
    // constraint instead (same approach as the child_process installs below).
    installGuardedProperty<(...args: never[]) => unknown>(dns, method, guardCallbackMethod);
    installGuardedProperty<(...args: never[]) => unknown>(
        dns.Resolver.prototype,
        method,
        guardCallbackMethod,
    );
    // dns.promises.*/dns.promises.Resolver.prototype.* always return a Promise, so these use the
    // reject-not-throw guard instead.
    installGuardedProperty<(...args: never[]) => Promise<unknown>>(
        dns.promises,
        method,
        guardNetworkPromiseMethod,
    );
    installGuardedProperty<(...args: never[]) => Promise<unknown>>(
        dns.promises.Resolver.prototype,
        method,
        guardNetworkPromiseMethod,
    );
}

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
installGuardedProperty<typeof child_process.execSync>(child_process, 'execSync', guardSubprocess);
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

// installGuardedProperty only patches each built-in's CJS default export; Node keeps ESM named
// bindings (`import { spawn } from 'node:child_process'`) as separate references to the original
// native values. syncBuiltinESMExports re-syncs them. Not unit-tested — Jest's CJS transform can't
// reproduce the real ESM-binding divergence; verified via a standalone `node --input-type=module` script.
syncBuiltinESMExports();

// Guards against the same abandoned-scope-corrupts-a-newer-one race as `local-execution.ts` — see `execution-epoch.ts`.
const blockEpoch = createEpochGuard();

export interface BlockedScopeHandle {
    // Invalidates this specific `runBlocked` call's scope, but only if it's still the active one —
    // a no-op once a newer call has superseded it. Unlike `forceReset()`, safe to call even while a
    // different scope is running, since it won't un-exempt that other scope's in-flight
    // `runAllowed` call.
    abandonIfCurrent(): void;
}

// Runs `fn` with network/subprocess access blocked; wraps the customer's function body in `local-execution.ts`'s `runScriptLocally`.
// `onScopeStarted`, if given, is invoked synchronously with a handle scoped to *this* call, for a
// caller whose own timeout might fire while `fn` is still pending (see `local-execution.ts`).
export async function runBlocked<T>(
    fn: () => Promise<T>,
    onScopeStarted?: (handle: BlockedScopeHandle) => void,
): Promise<T> {
    const scope = blockEpoch.start();
    onScopeStarted?.({ abandonIfCurrent: () => scope.concludeIfCurrent() });
    try {
        return await blockedContext.run(true, fn);
    } finally {
        scope.concludeIfCurrent();
    }
}

// Exempts `fn`'s own async chain (not siblings) from an active `runBlocked` scope; no-ops if that scope was already abandoned.
export async function runAllowed<T>(fn: () => Promise<T>): Promise<T> {
    if (!blockEpoch.hasActiveScope()) {
        return fn();
    }
    return allowedContext.run(true, fn);
}

// Test-only escape hatch for resetting shared module state between tests — unconditional, unlike
// `BlockedScopeHandle.abandonIfCurrent()`, since a test fully controls when scopes start and end.
export function forceReset(): void {
    blockEpoch.forceInvalidate();
}
