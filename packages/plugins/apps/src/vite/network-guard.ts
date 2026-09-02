// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis, Proxy */

import child_process from 'child_process';
import dgram from 'dgram';
import dns from 'dns';
import net from 'net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import worker_threads from 'worker_threads';

import { createEpochGuard } from './execution-epoch';

// Blocks every JS-level network/subprocess entry point during a local execution, since there's no OS-level sandbox here (unlike prod's Deno sandbox); block/allow state is scoped per-call via AsyncLocalStorage, not a global toggle, so unrelated concurrent callers aren't affected.

const NETWORK_BLOCKED_MESSAGE =
    'Network access is not allowed directly in backend functions — use $.Actions instead.';
const SUBPROCESS_BLOCKED_MESSAGE = 'Spawning a subprocess is not allowed in backend functions.';
const WORKER_THREAD_BLOCKED_MESSAGE =
    'Spawning a worker thread is not allowed in backend functions.';

// True only for the async chain of an active `runBlocked` call, not a process-wide flag, so a concurrent caller that never went through `runBlocked` isn't wrongly blocked too.
const blockedContext = new AsyncLocalStorage<true>();

// True only for the async chain started by a `runAllowed` call, not a process-wide flag, so a sibling call outside that chain stays blocked while the exemption is in flight.
const allowedContext = new AsyncLocalStorage<true>();

function isCurrentlyBlocked(): boolean {
    return blockedContext.getStore() === true && allowedContext.getStore() !== true;
}

// Installs a permanent getter/setter — needed because a detached, unawaited callback a customer function scheduled (e.g. a bare `setTimeout`) can still fire well after `runBlocked` itself has resolved, and must still be blocked, so the guard can never be torn down on a per-call basis. The setter captures whatever real implementation (or test mock) is later assigned as the delegate for non-blocked calls, AND rebuilds the exposed guard as a fresh function object on every write: some libraries that patch these same globals (e.g. MSW's fetch interceptor) mark the specific function object they last saw with their own "already patched" symbol, and reusing one frozen guard object forever means a second, independent session of that library collides with the mark an earlier one left on it in the same long-lived process — reproduced as a real Jest-worker crash (`Cannot redefine property: Symbol(isPatchedModule)`) when this file's guard and an unrelated test's own fetch mocking shared a worker. Rebuilding on every external write sidesteps that: each write hands external code a never-before-marked object.
function installGuardedProperty<T>(
    target: object,
    prop: string,
    makeGuard: (getReal: () => T) => T,
): void {
    let real = (target as Record<string, T>)[prop];
    const getReal = () => real;
    // Tracks which `real` value was active when each guard object was built. External code can
    // only ever read the guard through this property, never the true underlying value, so the
    // common "const original = x; x = mock; ...; x = original;" idiom hands the guard itself back
    // on restore. Without this map, assigning that guard into `real` makes it call itself forever
    // on the next unblocked invocation, since `getReal()` would just return the guard again.
    const realAtGuardCreation = new WeakMap<object, T>();

    function buildGuard(): T {
        const guard = makeGuard(getReal);
        // makeGuard can return a non-object (e.g. guardWebSocket returns undefined when the real
        // global doesn't exist on this Node version) — WeakMap.set() throws on a non-object key,
        // unlike get/has, which just return false/undefined for one.
        if (guard !== null && (typeof guard === 'object' || typeof guard === 'function')) {
            realAtGuardCreation.set(guard as object, real);
        }
        return guard;
    }

    let currentGuard = buildGuard();
    Object.defineProperty(target, prop, {
        configurable: true,
        enumerable: true,
        get: () => currentGuard,
        set: (value: T) => {
            real = realAtGuardCreation.has(value as object)
                ? (realAtGuardCreation.get(value as object) as T)
                : value;
            currentGuard = buildGuard();
        },
    });
}

function guardConnect(
    getReal: () => typeof net.Socket.prototype.connect,
): typeof net.Socket.prototype.connect {
    return function (this: net.Socket, ...args: unknown[]) {
        if (!isCurrentlyBlocked()) {
            return getReal().apply(this, args as Parameters<typeof net.Socket.prototype.connect>);
        }
        throw new Error(NETWORK_BLOCKED_MESSAGE);
    } as typeof net.Socket.prototype.connect;
}

// Rejects rather than throws synchronously, matching fetch's real contract so callers using `.catch()`/`.rejects` directly still work.
function guardFetch(getReal: () => typeof fetch): typeof fetch {
    return (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
        if (!isCurrentlyBlocked()) {
            return getReal()(...args);
        }
        return Promise.reject(new Error(NETWORK_BLOCKED_MESSAGE));
    };
}

// Same `this`-forwarding shape as guardConnect — shared by every plain, non-Promise-returning network
// entry point that has no special contract to preserve (unlike fetch's promise-rejection contract or
// exec/execFile's promisify.custom): dgram send/connect/bind, inbound listener setup
// (net.Server.listen), and the callback-style DNS resolver methods (dns.*, dns.Resolver.prototype.*)
// that bypass net/dgram's guards entirely via the native c-ares channel.
function guardNetworkMethod<F extends (...args: never[]) => unknown>(getReal: () => F): F {
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        if (!isCurrentlyBlocked()) {
            return (getReal() as unknown as (...a: unknown[]) => unknown).apply(this, args);
        }
        throw new Error(NETWORK_BLOCKED_MESSAGE);
    };
    return wrapper as unknown as F;
}

// Same `this`-forwarding shape as guardNetworkMethod, but rejects rather than throwing synchronously —
// same contract-preservation reasoning as guardFetch. dns.promises.* and dns.promises.Resolver.prototype.*
// always return a Promise, so a blocked call must reject that promise: a caller chaining `.catch()`
// directly (not inside an `await`/try-catch) would otherwise be left with an uncaught synchronous
// exception instead of the catchable rejection a real DNS failure would produce.
function guardNetworkPromiseMethod<F extends (...args: never[]) => Promise<unknown>>(
    getReal: () => F,
): F {
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        if (!isCurrentlyBlocked()) {
            return (getReal() as unknown as (...a: unknown[]) => unknown).apply(this, args);
        }
        return Promise.reject(new Error(NETWORK_BLOCKED_MESSAGE));
    };
    return wrapper as unknown as F;
}

// The global `WebSocket` constructor isn't in this project's @types/node surface (no `lib: "dom"`),
// even though newer Node versions provide it at runtime — `unknown` is the correct escape hatch, same
// reasoning as ChildProcess.prototype.spawn below. A Proxy construct trap, not a subclass, so a runtime
// swap of the real WebSocket (installGuardedProperty's setter) is picked up on the next `new`, not
// frozen at guard-creation time.
function guardWebSocket(getReal: () => unknown): unknown {
    const real = getReal();
    if (real === undefined) {
        // This repo's supported Node range spans versions where global WebSocket doesn't exist yet —
        // nothing to guard if it was never there; `new Proxy(undefined, ...)` would throw at install time.
        return undefined;
    }
    return new Proxy(real as object, {
        construct(_target, args) {
            if (isCurrentlyBlocked()) {
                throw new Error(NETWORK_BLOCKED_MESSAGE);
            }
            const RealWebSocket = getReal() as new (...a: unknown[]) => object;
            return new RealWebSocket(...args);
        },
    });
}

// A worker gets a fresh V8 realm with its own module registry, so nothing inside it inherits this
// file's monkeypatches or the AsyncLocalStorage block context — the only enforceable boundary is
// blocking construction itself, the same Proxy construct-trap shape as guardWebSocket.
function guardWorker(getReal: () => typeof worker_threads.Worker): typeof worker_threads.Worker {
    return new Proxy(getReal(), {
        construct(_target, args) {
            if (isCurrentlyBlocked()) {
                throw new Error(WORKER_THREAD_BLOCKED_MESSAGE);
            }
            return Reflect.construct(getReal(), args);
        },
    });
}

// Shared guard logic for every subprocess entry point, since each only differs in its real signature.
function guardSubprocess<F extends (...args: never[]) => unknown>(getReal: () => F): F {
    // Forwards `this` via `.apply`, since `ChildProcess.prototype.spawn`'s real implementation reads/writes fields on `this`, unlike the standalone functions.
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        if (!isCurrentlyBlocked()) {
            return (getReal() as unknown as (...a: unknown[]) => unknown).apply(this, args);
        }
        throw new Error(SUBPROCESS_BLOCKED_MESSAGE);
    };
    return wrapper as unknown as F;
}

// exec/execFile carry a native `util.promisify.custom` implementation resolving `{stdout, stderr}` (and attaching both onto a rejected error, matching Node's own contract) — `util.promisify()` uses it instead of its generic single-value fallback. That symbol lives on the specific function object, not something a fresh wrapper inherits, so `guardSubprocess` alone silently drops it and breaks any promisified caller (this repo's own `@dd/tools` execute() helper is one). Reusing the ORIGINAL symbol's implementation isn't safe either: Node's version calls straight into the native binding, bypassing the reassignable property and escaping the block guard entirely. This calls the already-guarded `wrapper` itself (not `getReal()` directly) so the block check has exactly one implementation, converting its synchronous block-throw into a rejection to match promisify's contract.
function guardSubprocessWithPromisifyCustom<F extends (...args: never[]) => unknown>(
    getReal: () => F,
): F {
    const wrapper = guardSubprocess(getReal);
    Object.defineProperty(wrapper, promisify.custom, {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) =>
            new Promise((resolve, reject) => {
                try {
                    (wrapper as unknown as (...a: unknown[]) => unknown)(
                        ...args,
                        (error: unknown, stdout: unknown, stderr: unknown) => {
                            if (error) {
                                reject(Object.assign(error as object, { stdout, stderr }));
                            } else {
                                resolve({ stdout, stderr });
                            }
                        },
                    );
                } catch (blockedError) {
                    reject(blockedError);
                }
            }),
    });
    return wrapper;
}

installGuardedProperty(net.Socket.prototype, 'connect', guardConnect);
installGuardedProperty(globalThis, 'fetch', guardFetch);
// dgram (UDP) and the native WebSocket global are separate entry points from fetch/net —
// neither goes through net.Socket, so they need their own guards.
installGuardedProperty<typeof dgram.Socket.prototype.send>(
    dgram.Socket.prototype,
    'send',
    guardNetworkMethod,
);
installGuardedProperty<typeof dgram.Socket.prototype.connect>(
    dgram.Socket.prototype,
    'connect',
    guardNetworkMethod,
);
// Inbound listeners are a separate entry point from the outbound send/connect above — a dependency
// can still open a real listening socket via net.createServer().listen(...) or dgram's .bind(...).
installGuardedProperty<typeof net.Server.prototype.listen>(
    net.Server.prototype,
    'listen',
    guardNetworkMethod,
);
installGuardedProperty<typeof dgram.Socket.prototype.bind>(
    dgram.Socket.prototype,
    'bind',
    guardNetworkMethod,
);
installGuardedProperty<unknown>(globalThis, 'WebSocket', guardWebSocket);

// dns.resolve*/dns.promises.resolve*/dns.Resolver/dns.promises.Resolver all go through Node's native
// c-ares channel, never touching the patched net.Socket/dgram.Socket methods above — each of the 4
// surfaces is a genuinely distinct function object needing its own guard. dns.lookup is deliberately
// excluded here — a separate, already-decided Out-of-Scope call.
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
    // Matches the child_process 'fork'/'exec' calls below: the guards are generic, and this loop's
    // target real signature differs per method/surface, so the type argument is pinned to each
    // guard's own constraint rather than each method's real (and here, irrelevant) shape.
    installGuardedProperty<(...args: never[]) => unknown>(dns, method, guardNetworkMethod);
    installGuardedProperty<(...args: never[]) => unknown>(
        dns.Resolver.prototype,
        method,
        guardNetworkMethod,
    );
    // dns.promises.*/dns.promises.Resolver.prototype.* always return a Promise, so these two use the
    // reject-not-throw guard above instead — matching the real contract callback-style dns.*/
    // dns.Resolver.prototype.* don't have.
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

installGuardedProperty<typeof child_process.spawn>(child_process, 'spawn', guardSubprocess);
installGuardedProperty<typeof child_process.spawnSync>(child_process, 'spawnSync', guardSubprocess);
// `unknown` is the correct escape hatch here: exec/execFile's `__promisify__` property doesn't structurally satisfy a plain function type.
installGuardedProperty<(...args: never[]) => unknown>(
    child_process,
    'exec',
    guardSubprocessWithPromisifyCustom,
);
installGuardedProperty<typeof child_process.execSync>(child_process, 'execSync', guardSubprocess);
installGuardedProperty<(...args: never[]) => unknown>(
    child_process,
    'execFile',
    guardSubprocessWithPromisifyCustom,
);
installGuardedProperty<typeof child_process.execFileSync>(
    child_process,
    'execFileSync',
    guardSubprocess,
);
installGuardedProperty<(...args: never[]) => unknown>(child_process, 'fork', guardSubprocess);
// Also guards `ChildProcess.prototype.spawn` directly, since spawn/exec/... above are thin wrappers around it that a dependency could call to bypass those guards; its signature isn't exported, so `unknown` is the correct escape hatch.
const childProcessPrototype = child_process.ChildProcess.prototype as unknown as Record<
    string,
    unknown
>;
installGuardedProperty<(...args: never[]) => unknown>(
    childProcessPrototype,
    'spawn',
    guardSubprocess,
);

installGuardedProperty<typeof worker_threads.Worker>(worker_threads, 'Worker', guardWorker);

// `installGuardedProperty` above only patches each built-in's CJS-style default-export object;
// Node keeps ESM named bindings (e.g. `import { spawn } from 'node:child_process'` or
// `import { Worker } from 'node:worker_threads'`) as separate references that stay bound to the
// original native values regardless of when this runs relative to that import. `syncBuiltinESMExports`
// re-syncs those bindings to the current default-export values, so a dependency importing any named
// form still hits the guard. Not unit-tested here: Jest's CJS transform compiles a named import into
// a live property read on the same object this file patches, so it can't reproduce the real
// ESM-binding divergence this fixes — verified instead with a standalone `node --input-type=module`
// script confirming `spawn !== cp.spawn` before this call and `spawn === cp.spawn` after it.
syncBuiltinESMExports();

// Guards against the same abandoned-scope-corrupts-a-newer-one race as `local-execution.ts` — see `execution-epoch.ts`.
const blockEpoch = createEpochGuard();

// Runs `fn` with network/subprocess access blocked; wraps the customer's function body in `local-execution.ts`'s `runScriptLocally`.
export async function runBlocked<T>(fn: () => Promise<T>): Promise<T> {
    const scope = blockEpoch.start();
    try {
        return await blockedContext.run(true, fn);
    } finally {
        scope.concludeIfCurrent();
    }
}

// Exempts `fn`'s own async chain (not siblings) from an active `runBlocked` scope; no-ops if that scope was already abandoned via `forceReset`.
export async function runAllowed<T>(fn: () => Promise<T>): Promise<T> {
    if (!blockEpoch.hasActiveScope()) {
        return fn();
    }
    return allowedContext.run(true, fn);
}

// Invalidates the active block scope independently of runBlocked's own try/finally, since a hung customer function would otherwise leave it blocked forever.
export function forceReset(): void {
    blockEpoch.forceInvalidate();
}
