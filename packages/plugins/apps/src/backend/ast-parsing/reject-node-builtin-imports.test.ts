// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rejectNodeBuiltinImports } from '@dd/apps-plugin/backend/ast-parsing/reject-node-builtin-imports';
import type { ImportDeclaration, Program } from 'estree';

/**
 * Helper to build a minimal ESTree Program for testing.
 */
function program(body: Program['body']): Program {
    return { type: 'Program', sourceType: 'module', body };
}

/**
 * Helper to build a minimal ImportDeclaration node for a given source.
 */
function importDecl(source: string, overrides: Partial<ImportDeclaration> = {}): ImportDeclaration {
    return {
        type: 'ImportDeclaration',
        specifiers: [
            {
                type: 'ImportDefaultSpecifier',
                local: { type: 'Identifier', name: 'x' },
            },
        ],
        source: { type: 'Literal', value: source },
        attributes: [],
        ...overrides,
    };
}

describe('Backend Functions - rejectNodeBuiltinImports', () => {
    const filePath = '/project/src/math.backend.ts';

    const allowedCases = [
        {
            description: 'allow importing a relative module',
            source: './helpers',
        },
        {
            description: 'allow importing a scoped npm package',
            source: '@datadog/action-catalog',
        },
        {
            description: 'allow importing an ordinary npm package',
            source: 'lodash',
        },
    ];

    test.each(allowedCases)('Should $description', ({ source }) => {
        const ast = program([importDecl(source)]);
        expect(() => rejectNodeBuiltinImports(ast, filePath)).not.toThrow();
    });

    const rejectedCases = [
        {
            description: 'reject importing "node:fs" via the node: prefix',
            source: 'node:fs',
        },
        {
            description: 'reject importing the bare built-in "fs"',
            source: 'fs',
        },
        {
            description: 'reject importing "child_process"',
            source: 'child_process',
        },
        {
            description: 'reject importing "node:child_process"',
            source: 'node:child_process',
        },
        {
            description: 'reject importing "net"',
            source: 'net',
        },
        {
            description: 'reject importing a built-in subpath "fs/promises"',
            source: 'fs/promises',
        },
    ];

    test.each(rejectedCases)('Should $description', ({ source }) => {
        const ast = program([importDecl(source)]);
        expect(() => rejectNodeBuiltinImports(ast, filePath)).toThrow(
            `Importing Node built-in module "${source}" is not supported in .backend.ts files`,
        );
        expect(() => rejectNodeBuiltinImports(ast, filePath)).toThrow(filePath);
    });

    test('Should allow a type-only import of a Node built-in', () => {
        // import type { Stats } from 'fs';
        const ast = program([
            importDecl('fs', { importKind: 'type' } as Partial<ImportDeclaration>),
        ]);
        expect(() => rejectNodeBuiltinImports(ast, filePath)).not.toThrow();
    });

    test('Should ignore non-import statements', () => {
        const ast = program([
            {
                type: 'ExpressionStatement',
                expression: { type: 'Literal', value: 1 },
            },
        ]);
        expect(() => rejectNodeBuiltinImports(ast, filePath)).not.toThrow();
    });
});
