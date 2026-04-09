// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

const BASE_OPTIONS = {
    filePath: '/src/utils.ts',
    buildRoot: '/',
    honorSkipComments: false,
    functionTypes: undefined,
    namedOnly: false,
};

describe('transform runtime loading', () => {
    afterEach(() => {
        jest.resetModules();
        jest.unmock('@babel/parser');
    });

    it('should not eagerly load @babel/parser on module import', () => {
        jest.isolateModules(() => {
            jest.doMock('@babel/parser', () => {
                throw new Error('parser loaded eagerly');
            });

            expect(() => require('./index')).not.toThrow();
        });
    });

    it('should load @babel/parser when transforming instrumentable code', () => {
        jest.isolateModules(() => {
            const parseMock = jest.fn(() => {
                throw new Error('parser loaded lazily');
            });

            jest.doMock('@babel/parser', () => ({ parse: parseMock }));

            const { transformCode } = require('./index') as typeof import('./index');

            expect(() =>
                transformCode({
                    ...BASE_OPTIONS,
                    code: 'function add(a, b) { return a + b; }',
                }),
            ).toThrow('parser loaded lazily');
            expect(parseMock).toHaveBeenCalledTimes(1);
        });
    });
});
