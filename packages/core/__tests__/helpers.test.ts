// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

describe('Helpers', () => {
    const mockModule = {
        issuer: {
            userRequest: 'moduleName',
        },
    };

    afterEach(() => {
        jest.clearAllMocks();
        jest.resetModules();
    });

    test('It should use the module with webpack4', () => {
        const compilationMock = {};
        const { getModuleName } = require('../helpers');
        expect(getModuleName(mockModule, compilationMock)).toBe('moduleName');
    });

    test('It should use the moduleGraphAPI with webpack5', () => {
        const compilationMock = {
            moduleGraph: {
                getIssuer: () => ({
                    userRequest: 'moduleName2',
                }),
            },
        };
        const { getModuleName } = require('../helpers');
        expect(getModuleName(mockModule, compilationMock)).toBe('moduleName2');
    });

    test('It should return the size of a module', () => {
        const { getModuleSize } = require('../helpers');
        const module1 = { size: 1 };
        const module2 = { size: () => 2 };
        expect(getModuleSize(module1)).toBe(1);
        expect(getModuleSize(module2)).toBe(2);
        expect(getModuleSize()).toBe(0);
    });

    test.each([
        [10, '10ms'],
        [10010, '10s 10ms'],
        [1000010, '16m 40s 10ms'],
        [10000010, '2h 46m 40s 10ms'],
        [1000000010, '11d 13h 46m 40s 10ms'],
    ])('It should format duration', (ms, expected) => {
        const { formatDuration } = require('../helpers');
        expect(formatDuration(ms)).toBe(expected);
    });

    test('It should getContext with and without constructor', () => {
        const { getContext } = require('../helpers');

        const BasicClass: any = function BasicClass() {};
        const instance1 = new BasicClass();
        const instance2 = new BasicClass();
        instance2.constructor = null;

        expect(() => {
            getContext([instance1, instance2]);
        }).not.toThrow();
    });
});
