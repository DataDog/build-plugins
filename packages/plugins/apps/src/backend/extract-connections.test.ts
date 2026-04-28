// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    extractConnectionIds,
    findConnectionsFile,
} from '@dd/apps-plugin/backend/extract-connections';
import type {
    ExportNamedDeclaration,
    ObjectExpression,
    Program,
    Property,
    SpreadElement,
} from 'estree';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

/**
 * Build a minimal ESTree Program node containing the given top-level statements.
 */
function program(body: Program['body']): Program {
    return { type: 'Program', sourceType: 'module', body };
}

/**
 * Build an `export const <name> = <object>` declaration.
 */
function exportConnections(
    properties: ObjectExpression['properties'],
    name: 'connections' | 'CONNECTIONS' = 'connections',
): ExportNamedDeclaration {
    return {
        type: 'ExportNamedDeclaration',
        declaration: {
            type: 'VariableDeclaration',
            kind: 'const',
            declarations: [
                {
                    type: 'VariableDeclarator',
                    id: { type: 'Identifier', name },
                    init: { type: 'ObjectExpression', properties },
                },
            ],
        },
        specifiers: [],
        source: null,
        attributes: [],
    };
}

/**
 * Build a `KEY: 'value'` ObjectExpression property whose value is a string literal.
 */
function stringProperty(key: string, value: string): Property {
    return {
        type: 'Property',
        key: { type: 'Identifier', name: key },
        value: { type: 'Literal', value },
        kind: 'init',
        method: false,
        shorthand: false,
        computed: false,
    };
}

const filePath = '/project/connections.ts';

describe('extract-connections - extractConnectionIds', () => {
    const acceptedCases = [
        {
            description: 'single literal value',
            ast: program([exportConnections([stringProperty('OPEN_AI', 'uuid-1')])]),
            expected: ['uuid-1'],
        },
        {
            description: 'multiple values, sorted and deduplicated',
            ast: program([
                exportConnections([
                    stringProperty('A', 'uuid-z'),
                    stringProperty('B', 'uuid-a'),
                    stringProperty('C', 'uuid-z'),
                ]),
            ]),
            expected: ['uuid-a', 'uuid-z'],
        },
        {
            description: 'string-literal keys',
            ast: program([
                exportConnections([
                    {
                        type: 'Property',
                        key: { type: 'Literal', value: 'open-ai' },
                        value: { type: 'Literal', value: 'uuid-1' },
                        kind: 'init',
                        method: false,
                        shorthand: false,
                        computed: false,
                    },
                ]),
            ]),
            expected: ['uuid-1'],
        },
        {
            description: 'template literal value with no interpolation',
            ast: program([
                exportConnections([
                    {
                        type: 'Property',
                        key: { type: 'Identifier', name: 'OPEN_AI' },
                        value: {
                            type: 'TemplateLiteral',
                            expressions: [],
                            quasis: [
                                {
                                    type: 'TemplateElement',
                                    value: { cooked: 'uuid-tmpl', raw: 'uuid-tmpl' },
                                    tail: true,
                                },
                            ],
                        },
                        kind: 'init',
                        method: false,
                        shorthand: false,
                        computed: false,
                    },
                ]),
            ]),
            expected: ['uuid-tmpl'],
        },
        {
            description: 'empty object',
            ast: program([exportConnections([])]),
            expected: [],
        },
        {
            description: 'uppercase CONNECTIONS variable name',
            ast: program([
                exportConnections([stringProperty('OPEN_AI', 'uuid-upper')], 'CONNECTIONS'),
            ]),
            expected: ['uuid-upper'],
        },
    ];

    test.each(acceptedCases)('Should accept $description', ({ ast, expected }) => {
        expect(extractConnectionIds(ast, filePath, '')).toEqual(expected);
    });

    test('Should throw when no "export const connections" is present', () => {
        const ast = program([
            {
                type: 'VariableDeclaration',
                kind: 'const',
                declarations: [
                    {
                        type: 'VariableDeclarator',
                        id: { type: 'Identifier', name: 'connections' },
                        init: { type: 'ObjectExpression', properties: [] },
                    },
                ],
            },
        ]);
        expect(() => extractConnectionIds(ast, filePath, '')).toThrow(
            'connections file must define "export const CONNECTIONS" (or "connections") = { ... }',
        );
    });

    test('Should throw when default-exported instead of named export', () => {
        const ast = program([
            {
                type: 'ExportDefaultDeclaration',
                declaration: { type: 'ObjectExpression', properties: [] },
            },
        ]);
        expect(() => extractConnectionIds(ast, filePath, '')).toThrow(
            'connections file must define "export const CONNECTIONS" (or "connections") = { ... }',
        );
    });

    test('Should throw when initialized with a non-object expression', () => {
        const ast = program([
            {
                type: 'ExportNamedDeclaration',
                declaration: {
                    type: 'VariableDeclaration',
                    kind: 'const',
                    declarations: [
                        {
                            type: 'VariableDeclarator',
                            id: { type: 'Identifier', name: 'connections' },
                            init: { type: 'Literal', value: 'oops' },
                        },
                    ],
                },
                specifiers: [],
                source: null,
                attributes: [],
            },
        ]);
        expect(() => extractConnectionIds(ast, filePath, '')).toThrow(
            '"export const CONNECTIONS" (or "connections") must be initialized with an object literal',
        );
    });

    test('Should throw on multiple "export const connections" declarations', () => {
        const ast = program([
            exportConnections([stringProperty('A', 'uuid-1')]),
            exportConnections([stringProperty('B', 'uuid-2')]),
        ]);
        expect(() => extractConnectionIds(ast, filePath, '')).toThrow(
            'multiple top-level "export const CONNECTIONS" (or "connections") declarations are not allowed',
        );
    });

    test('Should throw when both "connections" and "CONNECTIONS" are exported', () => {
        const ast = program([
            exportConnections([stringProperty('A', 'uuid-1')], 'connections'),
            exportConnections([stringProperty('B', 'uuid-2')], 'CONNECTIONS'),
        ]);
        expect(() => extractConnectionIds(ast, filePath, '')).toThrow(
            'multiple top-level "export const CONNECTIONS" (or "connections") declarations are not allowed',
        );
    });

    test('Should throw on computed keys', () => {
        const ast = program([
            exportConnections([
                {
                    type: 'Property',
                    key: { type: 'Identifier', name: 'KEY' },
                    value: { type: 'Literal', value: 'uuid' },
                    kind: 'init',
                    method: false,
                    shorthand: false,
                    computed: true,
                },
            ]),
        ]);
        expect(() => extractConnectionIds(ast, filePath, '')).toThrow('computed keys');
    });

    test('Should throw on spread elements', () => {
        const ast = program([
            exportConnections([
                {
                    type: 'SpreadElement',
                    argument: { type: 'Identifier', name: 'other' },
                } as SpreadElement,
            ]),
        ]);
        expect(() => extractConnectionIds(ast, filePath, '')).toThrow('spread elements');
    });

    const rejectedValueCases: Array<{
        description: string;
        value: Property['value'];
        reasonContains: string;
    }> = [
        {
            description: 'identifier reference',
            value: { type: 'Identifier', name: 'someConst' },
            reasonContains: 'must be a string literal',
        },
        {
            description: 'env var (member expression)',
            value: {
                type: 'MemberExpression',
                object: {
                    type: 'MemberExpression',
                    object: { type: 'Identifier', name: 'process' },
                    property: { type: 'Identifier', name: 'env' },
                    computed: false,
                    optional: false,
                },
                property: { type: 'Identifier', name: 'OPEN_AI_ID' },
                computed: false,
                optional: false,
            },
            reasonContains: 'must be a string literal',
        },
        {
            description: 'binary expression (concatenation)',
            value: {
                type: 'BinaryExpression',
                operator: '+',
                left: { type: 'Literal', value: 'a-' },
                right: { type: 'Literal', value: 'b' },
            },
            reasonContains: 'must be a string literal',
        },
        {
            description: 'function call',
            value: {
                type: 'CallExpression',
                callee: { type: 'Identifier', name: 'getId' },
                arguments: [],
                optional: false,
            },
            reasonContains: 'must be a string literal',
        },
        {
            description: 'template literal with interpolation',
            value: {
                type: 'TemplateLiteral',
                expressions: [{ type: 'Identifier', name: 'suffix' }],
                quasis: [
                    {
                        type: 'TemplateElement',
                        value: { cooked: 'pre-', raw: 'pre-' },
                        tail: false,
                    },
                    {
                        type: 'TemplateElement',
                        value: { cooked: '', raw: '' },
                        tail: true,
                    },
                ],
            },
            reasonContains: 'template literals with interpolations',
        },
        {
            description: 'numeric literal',
            value: { type: 'Literal', value: 42 },
            reasonContains: 'must be a string literal',
        },
    ];

    test.each(rejectedValueCases)(
        'Should throw on non-literal value: $description',
        ({ value, reasonContains }) => {
            const property: Property = {
                type: 'Property',
                key: { type: 'Identifier', name: 'BAD' },
                value,
                kind: 'init',
                method: false,
                shorthand: false,
                computed: false,
            };
            const ast = program([exportConnections([property])]);
            expect(() => extractConnectionIds(ast, filePath, '')).toThrow(reasonContains);
        },
    );

    // Rollup's this.parse() (SWC) emits character offsets but no line:col,
    // so we derive line:col from `node.start` against the source text.
    // These tests use the real parser so a regression in offset handling
    // surfaces immediately.
    describe('framed source location from parseAst', () => {
        test('Should include line:col when value is not a string literal', async () => {
            const { parseAst } = await import('rollup/parseAst');
            // parseAst is a JS-only parser, so the source has no `as const`.
            const code = [
                'export const CONNECTIONS = {',
                "    A: 'good-uuid',",
                '    B: process.env.OPEN_AI_ID,',
                '};',
                '',
            ].join('\n');
            const ast = parseAst(code) as unknown as Program;

            expect(() => extractConnectionIds(ast, filePath, code)).toThrow(
                `must be a string literal; got MemberExpression (at ${filePath}:3:8)`,
            );
        });

        test('Should include line:col for the missing-export case', async () => {
            const { parseAst } = await import('rollup/parseAst');
            const code = 'const CONNECTIONS = {};\nexport default CONNECTIONS;\n';
            const ast = parseAst(code) as unknown as Program;

            expect(() => extractConnectionIds(ast, filePath, code)).toThrow(
                `connections file must define "export const CONNECTIONS" (or "connections") = { ... } (at ${filePath})`,
            );
        });
    });
});

describe('extract-connections - findConnectionsFile', () => {
    let buildRoot: string;

    beforeEach(async () => {
        buildRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'connections-test-'));
    });

    afterEach(async () => {
        await fsp.rm(buildRoot, { recursive: true, force: true });
    });

    test('Should return undefined when no connections file exists', async () => {
        await expect(findConnectionsFile(buildRoot)).resolves.toBeUndefined();
    });

    test.each([
        { ext: '.ts' as const },
        { ext: '.tsx' as const },
        { ext: '.js' as const },
        { ext: '.jsx' as const },
    ])('Should find connections$ext when it exists', async ({ ext }) => {
        const expected = path.join(buildRoot, `connections${ext}`);
        await fsp.writeFile(expected, 'export const connections = {} as const;');
        await expect(findConnectionsFile(buildRoot)).resolves.toBe(expected);
    });

    test('Should prefer .ts over other extensions', async () => {
        await fsp.writeFile(
            path.join(buildRoot, 'connections.ts'),
            'export const connections = {} as const;',
        );
        await fsp.writeFile(
            path.join(buildRoot, 'connections.tsx'),
            'export const connections = {} as const;',
        );
        await fsp.writeFile(
            path.join(buildRoot, 'connections.js'),
            'export const connections = {};',
        );
        await expect(findConnectionsFile(buildRoot)).resolves.toBe(
            path.join(buildRoot, 'connections.ts'),
        );
    });

    test('Should prefer .tsx over .js when .ts is absent', async () => {
        await fsp.writeFile(
            path.join(buildRoot, 'connections.tsx'),
            'export const connections = {} as const;',
        );
        await fsp.writeFile(
            path.join(buildRoot, 'connections.js'),
            'export const connections = {};',
        );
        await expect(findConnectionsFile(buildRoot)).resolves.toBe(
            path.join(buildRoot, 'connections.tsx'),
        );
    });
});
