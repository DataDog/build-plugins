// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parse } from '@babel/parser';
import type * as t from '@babel/types';

import type { BabelPath } from './babel-path.types';
import { resolveCjsDefaultExport } from './cjs-interop';
import {
    getLocalVariableDeclarations,
    getParameterNames,
    MAX_CAPTURE_VARIABLES,
} from './scopeTracker';

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const babelTypes = require('@babel/types') as typeof import('@babel/types');

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const traverse = resolveCjsDefaultExport(require('@babel/traverse')) as (
    ast: t.Node,
    visitors: Record<string, (path: BabelPath<t.Function>) => void>,
) => void;

function parseFunctionNode(code: string): t.Function {
    // The cast works around the @babel/parser bundling its own copy of
    // @babel/types which is structurally identical but nominally distinct.
    const ast = parse(code, {
        sourceType: 'module',
        plugins: ['typescript'],
    }) as unknown as t.Node;

    let functionNode: t.Function | null = null;
    traverse(ast, {
        'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod|ClassPrivateMethod':
            (path: BabelPath<t.Function>) => {
                if (!functionNode) {
                    functionNode = path.node;
                }
            },
    });

    if (!functionNode) {
        throw new Error(`No function found in: ${code}`);
    }
    return functionNode;
}

describe('scopeTracker', () => {
    describe('getParameterNames', () => {
        const cases = [
            {
                description: 'return simple parameter names',
                code: 'function f(a, b, c) {}',
                expected: ['a', 'b', 'c'],
            },
            {
                description: 'return destructured object parameter names',
                code: 'function f({ x, y }) {}',
                expected: ['x', 'y'],
            },
            {
                description: 'return destructured array parameter names',
                code: 'function f([a, b]) {}',
                expected: ['a', 'b'],
            },
            {
                description: 'return rest parameter name',
                code: 'function f(a, ...rest) {}',
                expected: ['a', 'rest'],
            },
            {
                description: 'return default parameter names',
                code: 'function f(a = 1, b = 2) {}',
                expected: ['a', 'b'],
            },
            {
                description: 'return nested destructured parameter names',
                code: 'function f({ a: { b, c } }) {}',
                expected: ['b', 'c'],
            },
            {
                description: 'skip holes in array destructuring',
                code: 'function f([, a, , b]) {}',
                expected: ['a', 'b'],
            },
            {
                description: 'return rest in object destructuring',
                code: 'function f({ a, ...rest }) {}',
                expected: ['a', 'rest'],
            },
            {
                description: 'return rest in array destructuring',
                code: 'function f([a, ...rest]) {}',
                expected: ['a', 'rest'],
            },
            {
                description: 'handle deeply nested mixed destructuring',
                code: 'function f({ items: [{ id }, ...others] }) {}',
                expected: ['id', 'others'],
            },
            {
                description: 'skip TypeScript this parameter',
                code: 'function f(this: Window, a: string) {}',
                expected: ['a'],
            },
            {
                description: 'return empty for no parameters',
                code: 'function f() {}',
                expected: [],
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            const node = parseFunctionNode(code);
            expect(getParameterNames(node, babelTypes)).toEqual(expected);
        });
    });

    describe('getLocalVariableDeclarations', () => {
        const cases = [
            {
                description: 'return top-level variable declaration names',
                code: 'function f() { const a = 1; let b = 2; var c = 3; }',
                expected: ['a', 'b', 'c'],
            },
            {
                description: 'return destructured local variable names',
                code: 'function f() { const { x, y } = obj; }',
                expected: ['x', 'y'],
            },
            {
                description: 'return array destructured local variable names',
                code: 'function f() { const [a, b] = arr; }',
                expected: ['a', 'b'],
            },
            {
                description: 'skip variables that shadow parameter names',
                code: 'function f(a) { var a = 1; var b = 2; }',
                expected: ['b'],
            },
            {
                description: 'skip variables that shadow the function name',
                code: 'function f() { const f = 1; const g = 2; }',
                expected: ['g'],
            },
            {
                description: 'ignore non-variable statements',
                code: 'function f() { if (true) {} for (;;) {} return 1; }',
                expected: [],
            },
            {
                description: 'return empty for arrow with expression body',
                code: 'const f = (a) => a + 1;',
                expected: [],
            },
            {
                description: 'return multiple declarators from a single declaration',
                code: 'function f() { const a = 1, b = 2, c = 3; }',
                expected: ['a', 'b', 'c'],
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            const node = parseFunctionNode(code);
            const declarations = getLocalVariableDeclarations(node, babelTypes);
            const names = declarations.map(({ name }) => name);
            expect(names).toEqual(expected);
        });
    });

    describe('MAX_CAPTURE_VARIABLES cap', () => {
        it('should truncate parameters at MAX_CAPTURE_VARIABLES', () => {
            const paramNames = Array.from({ length: 30 }, (_, i) => `p${i}`);
            const code = `function f(${paramNames.join(', ')}) {}`;
            const node = parseFunctionNode(code);
            const result = getParameterNames(node, babelTypes);

            expect(result).toHaveLength(MAX_CAPTURE_VARIABLES);
            expect(result).toEqual(paramNames.slice(0, MAX_CAPTURE_VARIABLES));
        });

        it('should not truncate at exactly MAX_CAPTURE_VARIABLES', () => {
            const paramNames = Array.from({ length: MAX_CAPTURE_VARIABLES }, (_, i) => `p${i}`);
            const code = `function f(${paramNames.join(', ')}) {}`;
            const node = parseFunctionNode(code);

            expect(getParameterNames(node, babelTypes)).toHaveLength(MAX_CAPTURE_VARIABLES);
        });

        it('should truncate local declarations at MAX_CAPTURE_VARIABLES', () => {
            const localNames = Array.from({ length: 30 }, (_, i) => `v${i}`);
            const locals = localNames.map((name) => `const ${name} = 0;`).join(' ');
            const code = `function f() { ${locals} }`;
            const node = parseFunctionNode(code);
            const declarations = getLocalVariableDeclarations(node, babelTypes);
            const result = declarations.map(({ name }) => name);

            expect(result).toHaveLength(MAX_CAPTURE_VARIABLES);
            expect(result).toEqual(localNames.slice(0, MAX_CAPTURE_VARIABLES));
        });
    });

    describe('TypeScript parameter properties', () => {
        it('should return name from a TS parameter property', () => {
            const code = 'class C { constructor(public name: string, private age: number) {} }';
            const node = parseFunctionNode(code);
            expect(getParameterNames(node, babelTypes)).toEqual(['name', 'age']);
        });
    });
});
