// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Each function below matches a distinct instrumentation code path exercised
// by the smoke tests in live-debugger/src/transform/index.test.ts.

// 1. Block body, single value return, shared entry/exit snapshot.
export function add(a, b) {
    return a + b;
}

// 2. Block body with local variables — split entry/exit snapshots ($dd_eN vs $dd_lN).
export function addWithLocal(a, b) {
    const sum = a + b;
    return sum;
}

// 3. Arrow with expression body.
export const double = (x) => x * 2;

// 4. Arrow with parenthesized expression body (object literal — paren stripping).
export const getObj = (x) => ({ key: x });

// 5. Function with no return statement — trailing $dd_return(undefined).
export function sideEffect(target, msg) {
    target.push(msg);
}

// 6. Multiple returns — two value returns rewritten.
export function abs(x) {
    if (x < 0) {
        return -x;
    }
    return x;
}

// 7. Bare return — `return;` prefixed with $dd_return(undefined) + trailing exit.
export function earlyExit(x) {
    if (!x) {
        return;
    }
    return x;
}

// 8. Exhaustive if/else returns — alwaysReturns true, no trailing undefined return.
export function sign(x) {
    if (x > 0) {
        return 1;
    } else {
        return -1;
    }
}

// 9. Function that throws — exercises the try/catch wrapper.
export function thrower() {
    throw new Error('boom');
}
