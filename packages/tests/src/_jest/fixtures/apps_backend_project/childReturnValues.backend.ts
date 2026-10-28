// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

const secret = Symbol('secret');

export async function returnCircular() {
    const value: Record<string, unknown> = {};
    value.self = value;
    return value;
}

export async function returnBigInt() {
    return BigInt(10);
}

export async function returnFunction() {
    return function notSerializable() {};
}

export async function returnMap() {
    return new Map([['a', 1]]);
}

export async function returnNestedSet() {
    return [1, new Set([1, 2, 3])];
}

export async function returnNestedNaN() {
    return { score: NaN };
}

export async function returnInfinity() {
    return Infinity;
}

export async function returnSymbolKey() {
    return { status: 'ok', [secret]: 'leaked' };
}

export async function returnSymbolKeyViaToJson() {
    return { status: 'ok', toJSON: () => ({ replaced: true, [secret]: 'leaked' }) };
}

export async function returnSymbolInArray() {
    return [1, Symbol('unsupported')];
}

export async function returnUndefinedInArray() {
    return [1, undefined, 2];
}

export async function returnUndefinedProperties() {
    return { status: 'ok', extra: undefined, '': undefined };
}

export async function returnUndefined() {
    return undefined;
}

let toJsonCalls = 0;

export async function returnCountingToJson() {
    return {
        toJSON() {
            toJsonCalls += 1;
            return { toJsonCalls };
        },
    };
}
