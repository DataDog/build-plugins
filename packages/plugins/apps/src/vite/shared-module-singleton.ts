// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Stashes a value on a stable Node core module (e.g. `fs`, `net`) keyed by `Symbol.for(key)`, so
 * every re-evaluation of a guard file (bundled copies, Jest's per-test-file isolation) resolves the
 * same instance instead of populating its own private one. `Symbol.for`, not `Symbol()`, so a
 * second evaluation recognizes the first evaluation's installed value. Non-configurable/
 * non-writable so no code holding a reference to `hostModule` can swap in a fake value.
 */
export function getOrCreateShared<T>(hostModule: object, key: string, factory: () => T): T {
    const symbol = Symbol.for(key);
    const registry = hostModule as Record<symbol, T | undefined>;
    // An own-property check, not `in` (which walks the prototype chain — an inherited symbol would
    // short-circuit this as already-installed) or a falsy check (`!registry[symbol]`, which misses a
    // legitimately falsy factory result and re-defines an already configurable:false property).
    if (!Object.prototype.hasOwnProperty.call(registry, symbol)) {
        Object.defineProperty(registry, symbol, {
            value: factory(),
            writable: false,
            configurable: false,
            enumerable: false,
        });
    }
    return registry[symbol] as T;
}
