// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Shared `this`-forwarding wrapper for any guarded entry point that just calls through when
// `shouldBlock` returns false, and signals failure when it returns true. `shouldBlock` receives the
// call's own arguments so a caller can block on either a fixed, argument-independent condition
// (network-guard.ts's isCurrentlyBlocked()) or an argument-dependent one (env-guard.ts's check for
// whether this specific path/fd is the environ file, which can itself throw on an unrelated fs
// error like EACCES/ELOOP). `getReal` is a lazy getter, not the function itself, so a runtime swap
// of the real implementation (a test's spyOn/restoreMock, or a dependency reassigning the property)
// is picked up on the next call instead of being frozen at wrap time. 'throw' is for APIs that
// genuinely throw synchronously; 'reject' matches every Promise-returning target — in 'reject' mode
// a `shouldBlock` throw is itself converted into a rejection rather than escaping synchronously,
// matching the Promise-returning contract every 'reject' caller (e.g. fs.promises.*) actually has.
// `shouldBlock`'s parameter type can't be tied to F's own Parameters here: at every call site
// (wrapGuardedFsFn, guardNetworkPromiseMethod, ...) F is itself still a generic, unresolved type
// parameter, and TypeScript falls back to F's `never[]` constraint rather than the concrete
// signature it's eventually instantiated with — so a narrower type would reject every real
// `shouldBlock` implementation these callers actually pass. `unknown[]` is the accepted cost: it
// stops the compiler from catching a `shouldBlock` that reads the wrong argument position, so a new
// guarded entry point whose relevant argument isn't in position 0 needs that reviewed by hand.
export function makeGuardWrapper<F extends (...args: never[]) => unknown>(
    getReal: () => F,
    shouldBlock: (...args: unknown[]) => boolean,
    blockedMessage: string,
    onBlocked: 'throw' | 'reject',
): F {
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        let blocked: boolean;
        if (onBlocked === 'reject') {
            try {
                blocked = shouldBlock(...args);
            } catch (error) {
                return Promise.reject(error);
            }
        } else {
            blocked = shouldBlock(...args);
        }
        if (!blocked) {
            return (getReal() as unknown as (...a: unknown[]) => unknown).apply(this, args);
        }
        if (onBlocked === 'reject') {
            return Promise.reject(new Error(blockedMessage));
        }
        throw new Error(blockedMessage);
    };
    return wrapper as unknown as F;
}
