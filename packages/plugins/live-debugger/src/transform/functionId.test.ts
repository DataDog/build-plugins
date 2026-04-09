// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parse } from '@babel/parser';
import type * as t from '@babel/types';

import type { BabelPath } from './babel-path.types';
import { resolveCjsDefaultExport } from './cjs-interop';
import { generateFunctionId, getFunctionName } from './functionId';

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const traverse = resolveCjsDefaultExport(require('@babel/traverse')) as (
    ast: t.Node,
    visitors: Record<string, (path: BabelPath<t.Function>) => void>,
) => void;

function parseFunctionPaths(code: string): BabelPath<t.Function>[] {
    // The cast works around the @babel/parser bundling its own copy of
    // @babel/types which is structurally identical but nominally distinct.
    const ast = parse(code, {
        sourceType: 'module',
        plugins: ['typescript'],
    }) as unknown as t.Node;
    const paths: BabelPath<t.Function>[] = [];

    traverse(ast, {
        'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod|ClassPrivateMethod':
            (path: BabelPath<t.Function>) => {
                paths.push(path);
            },
    });

    return paths;
}

function parseSingleFunction(code: string): BabelPath<t.Function> {
    const paths = parseFunctionPaths(code);
    if (paths.length === 0) {
        throw new Error(`No function found in: ${code}`);
    }
    return paths[0];
}

describe('getFunctionName', () => {
    describe('named function declarations', () => {
        const cases = [
            {
                description: 'return name from a named function declaration',
                code: 'function foo() {}',
                expected: 'foo',
            },
            {
                description: 'return name from a named function expression',
                code: 'const x = function bar() {};',
                expected: 'bar',
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            expect(getFunctionName(parseSingleFunction(code))).toBe(expected);
        });
    });

    describe('object methods', () => {
        const cases = [
            {
                description: 'return name from an object method',
                code: 'const o = { foo() {} };',
                expected: 'foo',
            },
            {
                description: 'return name from a string-keyed object method',
                code: 'const o = { "my-method"() {} };',
                expected: 'my-method',
            },
            {
                description: 'return name from a numeric-keyed object method',
                code: 'const o = { 42() {} };',
                expected: '42',
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            expect(getFunctionName(parseSingleFunction(code))).toBe(expected);
        });
    });

    describe('class methods', () => {
        const cases = [
            {
                description: 'return name from a class method',
                code: 'class C { foo() {} }',
                expected: 'foo',
            },
            {
                description: 'return name from a static class method',
                code: 'class C { static bar() {} }',
                expected: 'bar',
            },
            {
                description: 'return name from a class private method',
                code: 'class C { #secret() {} }',
                expected: '#secret',
            },
            {
                description: 'return name from a string-keyed class method',
                code: 'class C { "my-method"() {} }',
                expected: 'my-method',
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            expect(getFunctionName(parseSingleFunction(code))).toBe(expected);
        });
    });

    describe('variable declarations', () => {
        const cases = [
            {
                description: 'return name from a const arrow function',
                code: 'const foo = () => {};',
                expected: 'foo',
            },
            {
                description: 'return name from a let function expression',
                code: 'let foo = function() {};',
                expected: 'foo',
            },
            {
                description: 'return name from a var function expression',
                code: 'var foo = function() {};',
                expected: 'foo',
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            expect(getFunctionName(parseSingleFunction(code))).toBe(expected);
        });
    });

    describe('assignment expressions', () => {
        const cases = [
            {
                description: 'return name from an identifier assignment',
                code: 'let foo; foo = () => {};',
                expected: 'foo',
            },
            {
                description: 'return name from a member expression assignment',
                code: 'obj.foo = () => {};',
                expected: 'obj.foo',
            },
            {
                description: 'return name from a this member assignment',
                code: 'this.handler = () => {};',
                expected: 'this.handler',
            },
            {
                description: 'return name from a deep member chain assignment',
                code: 'a.b.c = () => {};',
                expected: 'a.b.c',
            },
            {
                description: 'return null for a computed member assignment',
                code: 'obj[key] = () => {};',
                expected: null,
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            const paths = parseFunctionPaths(code);
            const fnPath = paths[paths.length - 1];
            expect(getFunctionName(fnPath)).toBe(expected);
        });
    });

    describe('object properties', () => {
        const cases = [
            {
                description: 'return name from an identifier-keyed object property',
                code: 'const o = { foo: () => {} };',
                expected: 'foo',
            },
            {
                description: 'return name from a string-keyed object property',
                code: 'const o = { "my-prop": () => {} };',
                expected: 'my-prop',
            },
            {
                description: 'return name from a numeric-keyed object property',
                code: 'const o = { 99: () => {} };',
                expected: '99',
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            expect(getFunctionName(parseSingleFunction(code))).toBe(expected);
        });
    });

    describe('class properties', () => {
        const cases = [
            {
                description: 'return name from a class property',
                code: 'class C { foo = () => {}; }',
                expected: 'foo',
            },
            {
                description: 'return name from a class private property',
                code: 'class C { #foo = () => {}; }',
                expected: '#foo',
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            expect(getFunctionName(parseSingleFunction(code))).toBe(expected);
        });
    });

    describe('anonymous functions', () => {
        const cases = [
            {
                description: 'return null for an anonymous arrow in an array',
                code: 'const arr = [() => {}];',
            },
            {
                description: 'return null for an anonymous arrow passed as argument',
                code: 'foo(() => {});',
            },
            {
                description: 'return null for an IIFE',
                code: '(function() {})();',
            },
        ];

        test.each(cases)('should $description', ({ code }) => {
            expect(getFunctionName(parseSingleFunction(code))).toBeNull();
        });
    });
});

describe('generateFunctionId', () => {
    describe('named functions', () => {
        const cases = [
            {
                description: 'produce relative-path;name for a named function',
                code: 'function hello() {}',
                filePath: '/project/src/utils.ts',
                buildRoot: '/project',
                expected: 'src/utils.ts;hello',
            },
            {
                description: 'handle a deeply nested file path',
                code: 'function hello() {}',
                filePath: '/project/src/features/auth/utils.ts',
                buildRoot: '/project',
                expected: 'src/features/auth/utils.ts;hello',
            },
            {
                description: 'handle a file at the build root',
                code: 'function main() {}',
                filePath: '/project/index.ts',
                buildRoot: '/project',
                expected: 'index.ts;main',
            },
        ];

        test.each(cases)('should $description', ({ code, filePath, buildRoot, expected }) => {
            const fnPath = parseSingleFunction(code);
            expect(generateFunctionId(filePath, buildRoot, fnPath, 0)).toBe(expected);
        });
    });

    describe('anonymous functions', () => {
        it('should produce <anonymous>@line:col:index for an anonymous function', () => {
            const fnPath = parseSingleFunction('[() => {}]');
            const line = fnPath.node.loc?.start.line ?? 0;
            const col = fnPath.node.loc?.start.column ?? 0;

            expect(generateFunctionId('/p/src/a.ts', '/p', fnPath, 3)).toBe(
                `src/a.ts;<anonymous>@${line}:${col}:3`,
            );
        });

        it('should differentiate anonymous siblings by index', () => {
            const fnPath = parseSingleFunction('foo(() => {})');
            const line = fnPath.node.loc?.start.line ?? 0;
            const col = fnPath.node.loc?.start.column ?? 0;

            const id0 = generateFunctionId('/p/f.ts', '/p', fnPath, 0);
            const id1 = generateFunctionId('/p/f.ts', '/p', fnPath, 1);

            expect(id0).toBe(`f.ts;<anonymous>@${line}:${col}:0`);
            expect(id1).toBe(`f.ts;<anonymous>@${line}:${col}:1`);
            expect(id0).not.toBe(id1);
        });

        it('should use 0:0 when location info is missing', () => {
            const fnPath = parseSingleFunction('foo(() => {})');
            const original = fnPath.node.loc;
            fnPath.node.loc = undefined as unknown as typeof original;

            expect(generateFunctionId('/p/f.ts', '/p', fnPath, 0)).toBe('f.ts;<anonymous>@0:0:0');

            fnPath.node.loc = original;
        });
    });
});
