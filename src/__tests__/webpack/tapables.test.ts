// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

describe('Tapables', () => {
    test('It should getContext with and without constructor', () => {
        const { Tapables } = require('../../webpack/tapables');
        const tapables = new Tapables();

        const BasicClass: any = function BasicClass() {};
        const instance1 = new BasicClass();
        const instance2 = new BasicClass();
        instance2.constructor = null;

        expect(() => {
            tapables.getContext([instance1, instance2]);
        }).not.toThrow();
    });

    test('It should not crash with read-only hooks', () => {
        const { Tapables } = require('../../webpack/tapables');
        const tapables = new Tapables();

        const mockTapable = {
            hooks: {
                hook1: Object.freeze({
                    tap: () => {},
                    tapAsync: () => {},
                    tapPromise: () => {},
                }),
            },
        };

        expect(() => {
            tapables.throughHooks(mockTapable);
        }).not.toThrow();
    });
});
