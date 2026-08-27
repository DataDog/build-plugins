// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/** Generation-counter guard so an abandoned scope's late cleanup can't touch a shared resource a newer scope now owns (used by `local-execution.ts`). */
export interface EpochScope {
    /** True until a newer scope starts, or this one (or every scope) is concluded/invalidated. */
    isCurrent(): boolean;
    /** Marks no scope active and returns true if still current, otherwise a no-op returning false — call in a `finally` to gate cleanup on still owning the resource. */
    concludeIfCurrent(): boolean;
}

export interface EpochGuard {
    /** Starts a new scope, superseding whichever one was previously active. */
    start(): EpochScope;
    /** True if some started scope hasn't yet been concluded or superseded. */
    hasActiveScope(): boolean;
    /** Unconditionally invalidates the active scope without starting a new one — the backstop for a scope whose own `fn` never settles. */
    forceInvalidate(): void;
}

export function createEpochGuard(): EpochGuard {
    let currentGeneration = 0;
    let activeGeneration: number | null = null;

    return {
        start() {
            const myGeneration = ++currentGeneration;
            activeGeneration = myGeneration;
            return {
                isCurrent: () => activeGeneration === myGeneration,
                concludeIfCurrent: () => {
                    if (activeGeneration === myGeneration) {
                        activeGeneration = null;
                        return true;
                    }
                    return false;
                },
            };
        },
        hasActiveScope() {
            return activeGeneration !== null;
        },
        forceInvalidate() {
            currentGeneration += 1;
            activeGeneration = null;
        },
    };
}
