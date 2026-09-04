// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Shared `this`-forwarding wrapper for any guarded entry point that calls through when
// `shouldBlock` returns false, and signals failure when it returns true. `getReal` is a lazy
// getter, not the function itself, so a runtime swap of the real implementation (a test's
// spyOn/restoreMock) is picked up on the next call instead of frozen at wrap time. 'reject' mode
// also converts a `shouldBlock` throw into a rejection, matching the Promise-returning contract
// every 'reject' caller actually has. `shouldBlock`'s parameter type is `unknown[]`, not tied to
// F's own Parameters: F is still a generic, unresolved type at every call site, so a narrower type
// would reject every real `shouldBlock` implementation these callers pass — the cost is that a new
// guarded entry point whose relevant argument isn't in position 0 needs manual review.
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

// The last argument is a function in every real call this wraps (fs.readFile/open/copyFile/cp all
// require their callback), so no other heuristic is needed to find it.
function invokeCallbackArg(args: unknown[], error: Error): void {
    const maybeCallback = args[args.length - 1];
    if (typeof maybeCallback === 'function') {
        // Deferred, not called synchronously: every real error-first-callback fs function reports
        // failure on a later tick, and a caller relying on that ordering (e.g. attaching state right
        // after the call, before the callback can possibly run) would otherwise observe this guard's
        // rejection out of sequence with a real one.
        process.nextTick(maybeCallback as (...cbArgs: unknown[]) => void, error);
    }
}

// For callback-style APIs whose real contract reports failure via an error-first callback, never a
// synchronous throw (fs.readFile/open/copyFile/cp) — makeGuardWrapper's 'throw' mode would break
// that contract. A `shouldBlock` throw is routed through the same callback for the same reason.
export function makeGuardCallbackWrapper<F extends (...args: never[]) => unknown>(
    getReal: () => F,
    shouldBlock: (...args: unknown[]) => boolean,
    blockedMessage: string,
): F {
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        let blocked: boolean;
        try {
            blocked = shouldBlock(...args);
        } catch (error) {
            invokeCallbackArg(args, error instanceof Error ? error : new Error(String(error)));
            return undefined;
        }
        if (!blocked) {
            return (getReal() as unknown as (...a: unknown[]) => unknown).apply(this, args);
        }
        invokeCallbackArg(args, new Error(blockedMessage));
        return undefined;
    };
    return wrapper as unknown as F;
}
