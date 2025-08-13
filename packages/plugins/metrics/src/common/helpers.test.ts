// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { defaultFilters } from '@dd/metrics-plugin/common/filters';
import { getModuleName, getValueContext, validateOptions } from '@dd/metrics-plugin/common/helpers';
import { CONFIG_KEY } from '@dd/metrics-plugin';
import {
    defaultPluginOptions,
    getMockCompilation,
    getMockModule,
} from '@dd/tests/_jest/helpers/mocks';

describe('Metrics Helpers', () => {
    describe('validateOptions', () => {
        test('Should return the default options', () => {
            const options = { ...defaultPluginOptions, [CONFIG_KEY]: {} };
            expect(validateOptions(options, 'webpack')).toEqual({
                enable: true,
                enableStaticPrefix: true,
                enableTracing: false,
                filters: defaultFilters,
                prefix: '',
                tags: [],
                timestamp: expect.any(Number),
            });
        });

        test('Should return the options with the provided values', () => {
            const fakeFilter = jest.fn();
            const options = {
                ...defaultPluginOptions,
                [CONFIG_KEY]: {
                    enable: false,
                    enableTracing: true,
                    filters: [fakeFilter],
                    prefix: 'prefix',
                    tags: ['tag1'],
                },
            };
            expect(validateOptions(options, 'webpack')).toEqual({
                enable: false,
                enableStaticPrefix: true,
                enableTracing: true,
                filters: [fakeFilter],
                prefix: 'prefix',
                tags: ['tag1'],
                timestamp: expect.any(Number),
            });
        });
    });

    describe('getModuleName', () => {
        test('Should use the moduleGraphAPI with webpack', () => {
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
    });

    describe('getValueContext', () => {
        test('Should getContext with and without constructor', () => {
            const BasicClass: any = function BasicClass() {};
            const instance1 = new BasicClass();
            const instance2 = new BasicClass();
            instance2.constructor = null;

            expect(() => {
                getValueContext([instance1, instance2]);
            }).not.toThrow();

            const context = getValueContext([instance1, instance2]);
            expect(context).toEqual([
                {
                    type: 'BasicClass',
                },
                {
                    type: 'object',
                },
            ]);
        });
    });
});
