// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    getModuleName,
    getModuleSize,
    getValueContext,
} from '@dd/telemetry-plugins/common/helpers';

import { getMockCompilation, getMockModule, mockCompilation } from '../testHelpers';

describe('Telemetry Helpers', () => {
    test('It should use the module with webpack4', () => {
        const mockModule = getMockModule({ name: 'moduleName' });
        expect(getModuleName(mockModule, mockCompilation)).toBe('moduleName');
    });

    test('It should use the moduleGraphAPI with webpack5', () => {
        const unnamedModule = getMockModule({ name: '' });
        const namedModule = getMockModule({ userRequest: 'moduleName' });
        expect(
            getModuleName(
                unnamedModule,
                getMockCompilation({
                    moduleGraph: {
                        getIssuer: () => namedModule,
                        getModule: () => namedModule,
                        issuer: namedModule,
                    },
                }),
            ),
        ).toBe('moduleName');
    });

    test('It should return the size of a module', () => {
        const module1 = getMockModule({ size: 1 });
        const module2 = getMockModule({ size: () => 2 });
        expect(getModuleSize(module1)).toBe(1);
        expect(getModuleSize(module2)).toBe(2);
        expect(getModuleSize()).toBe(0);
    });

    test('It should getContext with and without constructor', () => {
        const BasicClass: any = function BasicClass() {};
        const instance1 = new BasicClass();
        const instance2 = new BasicClass();
        instance2.constructor = null;

        getValueContext([instance1, instance2]);
        expect(() => {}).not.toThrow();
    });
});
