// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { extractExportedFunctions } from '@dd/apps-plugin/backend/discovery';
import type { Program } from 'estree';
import type { AstNode } from 'rollup';

/**
 * Helper to build a minimal ESTree Program AstNode for testing.
 */
function program(body: Program['body']): AstNode & Program {
    return { type: 'Program', sourceType: 'module', body, start: 0, end: 0 };
}

describe('Backend Functions - extractExportedFunctions', () => {
    const filePath = '/project/src/math.backend.ts';

    const cases = [
        {
            // export function add() {}
            // export function multiply() {}
            description: 'discover named function exports',
            ast: program([
                {
                    type: 'ExportNamedDeclaration',
                    declaration: {
                        type: 'FunctionDeclaration',
                        id: { type: 'Identifier', name: 'add' },
                        params: [],
                        body: { type: 'BlockStatement', body: [] },
                    },
                    specifiers: [],
                    source: null,
                    attributes: [],
                },
                {
                    type: 'ExportNamedDeclaration',
                    declaration: {
                        type: 'FunctionDeclaration',
                        id: { type: 'Identifier', name: 'multiply' },
                        params: [],
                        body: { type: 'BlockStatement', body: [] },
                    },
                    specifiers: [],
                    source: null,
                    attributes: [],
                },
            ]),
            expected: ['add', 'multiply'],
        },
        {
            // export const add = () => {}
            description: 'discover exported arrow function variables',
            ast: program([
                {
                    type: 'ExportNamedDeclaration',
                    declaration: {
                        type: 'VariableDeclaration',
                        kind: 'const' as const,
                        declarations: [
                            {
                                type: 'VariableDeclarator',
                                id: { type: 'Identifier', name: 'add' },
                                init: {
                                    type: 'ArrowFunctionExpression',
                                    params: [],
                                    body: { type: 'BlockStatement', body: [] },
                                    expression: false,
                                },
                            },
                        ],
                    },
                    specifiers: [],
                    source: null,
                    attributes: [],
                },
            ]),
            expected: ['add'],
        },
        {
            // export const add = function() {}
            description: 'discover exported function expression variables',
            ast: program([
                {
                    type: 'ExportNamedDeclaration',
                    declaration: {
                        type: 'VariableDeclaration',
                        kind: 'const' as const,
                        declarations: [
                            {
                                type: 'VariableDeclarator',
                                id: { type: 'Identifier', name: 'add' },
                                init: {
                                    type: 'FunctionExpression',
                                    id: null,
                                    params: [],
                                    body: { type: 'BlockStatement', body: [] },
                                },
                            },
                        ],
                    },
                    specifiers: [],
                    source: null,
                    attributes: [],
                },
            ]),
            expected: ['add'],
        },
        {
            // export const handler = importedHandler (ambiguous — allowed)
            description: 'allow exported variable with identifier init',
            ast: program([
                {
                    type: 'ExportNamedDeclaration',
                    declaration: {
                        type: 'VariableDeclaration',
                        kind: 'const' as const,
                        declarations: [
                            {
                                type: 'VariableDeclarator',
                                id: { type: 'Identifier', name: 'handler' },
                                init: { type: 'Identifier', name: 'importedHandler' },
                            },
                        ],
                    },
                    specifiers: [],
                    source: null,
                    attributes: [],
                },
            ]),
            expected: ['handler'],
        },
        {
            // export const handler = createHandler() (ambiguous — allowed)
            description: 'allow exported variable with call expression init',
            ast: program([
                {
                    type: 'ExportNamedDeclaration',
                    declaration: {
                        type: 'VariableDeclaration',
                        kind: 'const' as const,
                        declarations: [
                            {
                                type: 'VariableDeclarator',
                                id: { type: 'Identifier', name: 'handler' },
                                init: {
                                    type: 'CallExpression',
                                    callee: { type: 'Identifier', name: 'createHandler' },
                                    arguments: [],
                                    optional: false,
                                },
                            },
                        ],
                    },
                    specifiers: [],
                    source: null,
                    attributes: [],
                },
            ]),
            expected: ['handler'],
        },
        {
            // export { foo, bar }
            description: 'discover export specifiers',
            ast: program([
                {
                    type: 'ExportNamedDeclaration',
                    declaration: null,
                    specifiers: [
                        {
                            type: 'ExportSpecifier',
                            local: { type: 'Identifier', name: 'foo' },
                            exported: { type: 'Identifier', name: 'foo' },
                        },
                        {
                            type: 'ExportSpecifier',
                            local: { type: 'Identifier', name: 'bar' },
                            exported: { type: 'Identifier', name: 'bar' },
                        },
                    ],
                    source: null,
                    attributes: [],
                },
            ]),
            expected: ['foo', 'bar'],
        },
        {
            // 1;  (no exports)
            description: 'return empty array for no exports',
            ast: program([
                {
                    type: 'ExpressionStatement',
                    expression: { type: 'Literal', value: 1 },
                },
            ]),
            expected: [],
        },
    ];

    test.each(cases)('Should $description', ({ ast, expected }) => {
        expect(extractExportedFunctions(ast, filePath)).toEqual(expected);
    });

    test('Should throw on default export declaration', () => {
        const ast = program([
            {
                type: 'ExportDefaultDeclaration',
                declaration: { type: 'Literal', value: 1 },
            },
        ]);
        expect(() => extractExportedFunctions(ast, filePath)).toThrow(
            'Default exports are not supported in .backend.ts files',
        );
    });

    test.each([
        { initType: 'string literal', init: { type: 'Literal' as const, value: '1.0.0' } },
        {
            initType: 'object literal',
            init: { type: 'ObjectExpression' as const, properties: [] },
        },
        { initType: 'array literal', init: { type: 'ArrayExpression' as const, elements: [] } },
        {
            initType: 'template literal',
            init: { type: 'TemplateLiteral' as const, quasis: [], expressions: [] },
        },
        { initType: 'missing initializer', init: null },
    ])('Should throw on non-function variable export ($initType)', ({ init }) => {
        const ast = program([
            {
                type: 'ExportNamedDeclaration',
                declaration: {
                    type: 'VariableDeclaration',
                    kind: 'const' as const,
                    declarations: [
                        {
                            type: 'VariableDeclarator',
                            id: { type: 'Identifier', name: 'VERSION' },
                            init,
                        },
                    ],
                },
                specifiers: [],
                source: null,
                attributes: [],
            },
        ]);
        expect(() => extractExportedFunctions(ast, filePath)).toThrow(
            'Non-function export "VERSION"',
        );
    });

    test('Should throw on destructured variable export', () => {
        const ast = program([
            {
                type: 'ExportNamedDeclaration',
                declaration: {
                    type: 'VariableDeclaration',
                    kind: 'const' as const,
                    declarations: [
                        {
                            type: 'VariableDeclarator',
                            id: {
                                type: 'ObjectPattern',
                                properties: [
                                    {
                                        type: 'Property',
                                        key: { type: 'Identifier', name: 'a' },
                                        value: { type: 'Identifier', name: 'a' },
                                        kind: 'init' as const,
                                        computed: false,
                                        method: false,
                                        shorthand: true,
                                    },
                                ],
                            },
                            init: { type: 'Identifier', name: 'obj' },
                        },
                    ],
                },
                specifiers: [],
                source: null,
                attributes: [],
            },
        ]);
        expect(() => extractExportedFunctions(ast, filePath)).toThrow(
            'Destructured exports are not supported in backend files',
        );
    });

    test('Should throw on export { x as default }', () => {
        const ast = program([
            {
                type: 'ExportNamedDeclaration',
                declaration: null,
                specifiers: [
                    {
                        type: 'ExportSpecifier',
                        local: { type: 'Identifier', name: 'x' },
                        exported: { type: 'Identifier', name: 'default' },
                    },
                ],
                source: null,
                attributes: [],
            },
        ]);
        expect(() => extractExportedFunctions(ast, filePath)).toThrow(
            'Default exports are not supported in .backend.ts files',
        );
    });
});
