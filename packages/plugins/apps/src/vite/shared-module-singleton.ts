// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Stashes a value on a stable Node core module (e.g. `fs`, `net`) keyed by `Symbol.for(key)`, so
 * every re-evaluation of a guard file (bundled copies, Jest's per-test-file isolation) resolves the
 * SAME instance instead of populating its own private one — used by env-guard.ts and
 * network-guard.ts, both of which need one shared AsyncLocalStorage/state object across every
 * evaluation of themselves. `factory` runs at most once per key; `Symbol.for`, not `Symbol()`, so a
 * second evaluation recognizes the first evaluation's own installed value instead of minting its own
 * separate slot. Non-configurable/non-writable so no code holding a reference to `hostModule` can
 * swap in a fake value and disable every consumer of it at once.
 */
export function getOrCreateShared<T>(hostModule: object, key: string, factory: () => T): T {
    const symbol = Symbol.for(key);
    const registry = hostModule as unknown as Record<symbol, T | undefined>;
    // An existence check, not a falsy check (`!registry[symbol]`): a factory whose T legitimately
    // produces a falsy value (0, false, '', null) would otherwise never be recognized as already
    // installed, and a second call would attempt to redefine an already configurable:false property.
    if (!(symbol in registry)) {
        Object.defineProperty(registry, symbol, {
            value: factory(),
            writable: false,
            configurable: false,
            enumerable: false,
        });
    }
    return registry[symbol] as T;
}
