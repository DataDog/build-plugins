// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { protectInterceptors } from './protectInterceptors';

const interceptorSymbol = Symbol('interceptor');
const otherSymbol = Symbol('other');
const throwingSymbol = Symbol('throwing');
const interceptor = { symbol: interceptorSymbol };

const throwOnAccess = () => {
    throw new Error('Not accessible');
};

describe('protectInterceptors', () => {
    const cases = [
        {
            description: 'protect an interceptor stored under its own symbol',
            buildTarget: () => ({ [interceptorSymbol]: interceptor }),
            expectedProtected: [interceptor],
        },
        {
            description: 'skip an object stored under a different symbol',
            buildTarget: () => ({ [otherSymbol]: interceptor }),
            expectedProtected: [],
        },
        {
            description: 'skip a value that is not an object',
            buildTarget: () => ({ [interceptorSymbol]: 'interceptor' }),
            expectedProtected: [],
        },
        {
            description: 'keep going past a value that throws on access',
            buildTarget: () => {
                const target: Record<symbol, unknown> = {};
                Object.defineProperty(target, throwingSymbol, {
                    enumerable: true,
                    get: throwOnAccess,
                });
                target[interceptorSymbol] = interceptor;
                return target;
            },
            expectedProtected: [interceptor],
        },
        {
            description: 'keep going past an object whose symbol throws on access',
            buildTarget: () => {
                const throwingValue = {};
                Object.defineProperty(throwingValue, 'symbol', { get: throwOnAccess });
                return { [throwingSymbol]: throwingValue, [interceptorSymbol]: interceptor };
            },
            expectedProtected: [interceptor],
        },
    ];

    test.each(cases)('Should $description', ({ buildTarget, expectedProtected }) => {
        const protect = jest.fn();
        const target = buildTarget();

        protectInterceptors(target, protect);

        const protectedValues = protect.mock.calls.map(([value]) => value);
        expect(protectedValues).toEqual(expectedProtected);
    });
});
