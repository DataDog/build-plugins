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

const PEER_DEPS = ['@babel/parser', '@babel/traverse', '@babel/types', 'magic-string'] as const;

describe('peer-dependency loading', () => {
    afterEach(() => {
        jest.resetModules();
        for (const dep of PEER_DEPS) {
            jest.unmock(dep);
        }
    });

    describe('eager import surface', () => {
        it('should not load any peer dependency when importing the plugin entry', () => {
            jest.isolateModules(() => {
                for (const dep of PEER_DEPS) {
                    jest.doMock(dep, () => {
                        throw new Error(`${dep} loaded eagerly from src/index.ts`);
                    });
                }

                expect(() => require('../index')).not.toThrow();
            });
        });

        it('should not load any peer dependency when importing the transform loader', () => {
            jest.isolateModules(() => {
                for (const dep of PEER_DEPS) {
                    jest.doMock(dep, () => {
                        throw new Error(`${dep} loaded eagerly from transform/loader.ts`);
                    });
                }

                expect(() => require('./loader')).not.toThrow();
            });
        });
    });

    describe('getTransformCode() lazy chain', () => {
        it('should not load @babel/parser, @babel/traverse, or magic-string when resolving the transform module', () => {
            jest.isolateModules(() => {
                for (const dep of ['@babel/parser', '@babel/traverse', 'magic-string'] as const) {
                    jest.doMock(dep, () => {
                        throw new Error(`${dep} loaded prematurely`);
                    });
                }

                const { getTransformCode } = require('./loader') as typeof import('./loader');
                expect(() => getTransformCode()).not.toThrow();
            });
        });

        it('should load @babel/parser, @babel/traverse, and magic-string when transforming', () => {
            jest.isolateModules(() => {
                const parseMock = jest.fn(() => {
                    throw new Error('parser invoked');
                });
                jest.doMock('@babel/parser', () => ({ parse: parseMock }));

                const { getTransformCode } = require('./loader') as typeof import('./loader');
                const transformCode = getTransformCode();

                expect(() =>
                    transformCode({
                        ...BASE_OPTIONS,
                        code: 'function add(a, b) { return a + b; }',
                    }),
                ).toThrow('parser invoked');
                expect(parseMock).toHaveBeenCalledTimes(1);
            });
        });
    });

    describe('missing peer-dep diagnostics', () => {
        function missingModuleError(name: string): Error & { code: string } {
            const error = Object.assign(new Error(`Cannot find module '${name}' from somewhere`), {
                code: 'MODULE_NOT_FOUND',
            });
            return error;
        }

        it('should rewrap a missing @babel/types into an actionable error from getTransformCode()', () => {
            jest.isolateModules(() => {
                jest.doMock('@babel/types', () => {
                    throw missingModuleError('@babel/types');
                });

                const { getTransformCode } = require('./loader') as typeof import('./loader');

                expect(() => getTransformCode()).toThrow(/Datadog Live Debugger/);
                expect(() => getTransformCode()).toThrow(/@babel\/types/);
                expect(() => getTransformCode()).toThrow(/npm install/);
            });
        });

        it('should rewrap a missing @babel/parser into an actionable error when transforming', () => {
            jest.isolateModules(() => {
                jest.doMock('@babel/parser', () => {
                    throw missingModuleError('@babel/parser');
                });

                const { getTransformCode } = require('./loader') as typeof import('./loader');
                const transformCode = getTransformCode();

                expect(() =>
                    transformCode({
                        ...BASE_OPTIONS,
                        code: 'function add(a, b) { return a + b; }',
                    }),
                ).toThrow(/Datadog Live Debugger/);
            });
        });

        it('should not rewrap unrelated errors', () => {
            jest.isolateModules(() => {
                jest.doMock('@babel/types', () => {
                    throw new Error('unrelated boom');
                });

                const { getTransformCode } = require('./loader') as typeof import('./loader');

                expect(() => getTransformCode()).toThrow('unrelated boom');
            });
        });
    });
});
