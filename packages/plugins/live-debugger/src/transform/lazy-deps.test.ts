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

function missingModuleError(name: string): Error & { code: string } {
    return Object.assign(new Error(`Cannot find module '${name}' from somewhere`), {
        code: 'MODULE_NOT_FOUND',
    });
}

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

        it('should not load any peer dependency when importing the transform module', () => {
            jest.isolateModules(() => {
                for (const dep of PEER_DEPS) {
                    jest.doMock(dep, () => {
                        throw new Error(`${dep} loaded eagerly from transform/index.ts`);
                    });
                }

                expect(() => require('./index')).not.toThrow();
            });
        });
    });

    describe('lazy load on first transform call', () => {
        it('should load @babel/parser only when transforming instrumentable code', () => {
            jest.isolateModules(() => {
                const parseMock = jest.fn(() => {
                    throw new Error('parser invoked');
                });
                jest.doMock('@babel/parser', () => ({ parse: parseMock }));

                const { transformCode } = require('./index') as typeof import('./index');

                expect(() =>
                    transformCode({
                        ...BASE_OPTIONS,
                        code: 'function add(a, b) { return a + b; }',
                    }),
                ).toThrow('parser invoked');
                expect(parseMock).toHaveBeenCalledTimes(1);
            });
        });

        it('should not require peer deps for a file with no function syntax', () => {
            jest.isolateModules(() => {
                for (const dep of PEER_DEPS) {
                    jest.doMock(dep, () => {
                        throw new Error(`${dep} loaded for a non-instrumentable file`);
                    });
                }

                const { transformCode } = require('./index') as typeof import('./index');

                expect(() =>
                    transformCode({
                        ...BASE_OPTIONS,
                        code: 'export const FOO = 42;',
                    }),
                ).not.toThrow();
            });
        });
    });

    describe('missing peer-dep diagnostics', () => {
        it.each(PEER_DEPS)(
            'should rewrap a missing %s into an actionable error when transforming',
            (dep) => {
                jest.isolateModules(() => {
                    jest.doMock(dep, () => {
                        throw missingModuleError(dep);
                    });

                    const { transformCode } = require('./index') as typeof import('./index');

                    expect(() =>
                        transformCode({
                            ...BASE_OPTIONS,
                            code: 'function add(a, b) { return a + b; }',
                        }),
                    ).toThrow(/Datadog Live Debugger/);
                });
            },
        );

        it('should include the npm install hint in the rewrapped error', () => {
            jest.isolateModules(() => {
                jest.doMock('@babel/parser', () => {
                    throw missingModuleError('@babel/parser');
                });

                const { transformCode } = require('./index') as typeof import('./index');

                expect(() =>
                    transformCode({
                        ...BASE_OPTIONS,
                        code: 'function add(a, b) { return a + b; }',
                    }),
                ).toThrow(
                    /npm install --save-dev @babel\/parser @babel\/traverse @babel\/types magic-string/,
                );
            });
        });

        it('should not rewrap unrelated errors thrown during require', () => {
            jest.isolateModules(() => {
                jest.doMock('@babel/parser', () => {
                    throw new Error('unrelated boom');
                });

                const { transformCode } = require('./index') as typeof import('./index');

                expect(() =>
                    transformCode({
                        ...BASE_OPTIONS,
                        code: 'function add(a, b) { return a + b; }',
                    }),
                ).toThrow('unrelated boom');
            });
        });
    });
});
