// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Shared `this`-forwarding wrapper: calls through when `shouldBlock` returns false, else signals
// failure per `onBlocked` ('reject' also converts a `shouldBlock` throw into a rejection).
// `getReal` is a lazy getter so a runtime swap of the real implementation (spyOn/restoreMock) is
// picked up on the next call, not frozen at wrap time. `shouldBlock` takes `unknown[]`, not F's own
// Parameters, since F is unresolved at every call site — a new entry point whose relevant arg isn't
// in position 0 needs manual review as a result.
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
// require their callback), so no other heuristic is needed to find it. Exported for env-guard.ts's
// own hand-rolled cp wrappers, which need this same callback-reporting behavior for a guard failure
// that isn't just a fixed shouldBlock() result (see their own comment).
export function invokeCallbackArg(args: unknown[], error: Error): void {
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
