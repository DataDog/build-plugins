// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Each @mswjs/interceptors instance stores itself on the global object under its own `symbol`.
export const protectInterceptors = (target: object, protect: (value: object) => void) => {
    for (const symbol of Object.getOwnPropertySymbols(target)) {
        try {
            const value: unknown = Reflect.get(target, symbol);
            const isInterceptor =
                typeof value === 'object' &&
                value !== null &&
                Reflect.get(value, 'symbol') === symbol;
            if (isInterceptor) {
                protect(value);
            }
        } catch {
            // A value from another library can throw on access; skip it like jest-util does.
        }
    }
};
