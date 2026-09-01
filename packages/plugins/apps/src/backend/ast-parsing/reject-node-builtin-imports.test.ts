// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rejectNodeBuiltinImports } from '@dd/apps-plugin/backend/ast-parsing/reject-node-builtin-imports';
import type { TypeScriptImportExportMetadata } from '@dd/apps-plugin/backend/ast-parsing/type-guards';
import type {
    ExportNamedDeclaration,
    ExportSpecifier,
    ImportDeclaration,
    ImportSpecifier,
    Program,
} from 'estree';
import { parseAst } from 'rollup/parseAst';

function program(body: Program['body']): Program {
    return { type: 'Program', sourceType: 'module', body };
}

// `overrides` also accepts TypeScript's `importKind`/`exportKind` (not declared by `estree`), so type-only imports can be built without a cast.
function importDecl(
    source: string,
    overrides: Partial<ImportDeclaration> & TypeScriptImportExportMetadata = {},
): ImportDeclaration {
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

// Built by hand rather than parsed: `rollup/parseAst` can't parse TypeScript's `export type { ... }` syntax used by the type-only re-export test below.
function exportNamedDecl(
    source: string,
    overrides: Partial<ExportNamedDeclaration> & TypeScriptImportExportMetadata = {},
): ExportNamedDeclaration {
    return {
        type: 'ExportNamedDeclaration',
        declaration: null,
        specifiers: [
            {
                type: 'ExportSpecifier',
                local: { type: 'Identifier', name: 'readFile' },
                exported: { type: 'Identifier', name: 'readFile' },
            },
        ],
        source: { type: 'Literal', value: source },
        attributes: [],
        ...overrides,
    };
}

// Same technique as `importDecl` above, for TypeScript's inline `importKind`.
function importSpecifier(
    name: string,
    overrides: Partial<ImportSpecifier> & TypeScriptImportExportMetadata = {},
): ImportSpecifier & TypeScriptImportExportMetadata {
    return {
        type: 'ImportSpecifier',
        imported: { type: 'Identifier', name },
        local: { type: 'Identifier', name },
        ...overrides,
    };
}

// Same technique as `exportNamedDecl` above, for TypeScript's inline `exportKind`.
function exportSpecifier(
    name: string,
    overrides: Partial<ExportSpecifier> & TypeScriptImportExportMetadata = {},
): ExportSpecifier & TypeScriptImportExportMetadata {
    return {
        type: 'ExportSpecifier',
        local: { type: 'Identifier', name },
        exported: { type: 'Identifier', name },
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
        const importDeclaration = importDecl(source);
        const ast = program([importDeclaration]);
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
        const importDeclaration = importDecl(source);
        const ast = program([importDeclaration]);
        expect(() => rejectNodeBuiltinImports(ast, filePath)).toThrow(
            `Importing Node built-in module "${source}" is not supported in backend function code`,
        );
        expect(() => rejectNodeBuiltinImports(ast, filePath)).toThrow(filePath);
    });

    test('Should allow a type-only import of a Node built-in', () => {
        // import type { Stats } from 'fs';
        const importDeclaration = importDecl('fs', { importKind: 'type' });
        const ast = program([importDeclaration]);
        expect(() => rejectNodeBuiltinImports(ast, filePath)).not.toThrow();
    });

    test('Should allow an inline type-only named specifier of a Node built-in', () => {
        // import { type Stats } from 'fs';
        const importDeclaration = importDecl('fs', {
            specifiers: [importSpecifier('Stats', { importKind: 'type' })],
        });
        const ast = program([importDeclaration]);
        expect(() => rejectNodeBuiltinImports(ast, filePath)).not.toThrow();
    });

    test('Should reject when only one of several named specifiers is inline type-only', () => {
        // import { type Stats, readFileSync } from 'fs';
        const importDeclaration = importDecl('fs', {
            specifiers: [
                importSpecifier('Stats', { importKind: 'type' }),
                importSpecifier('readFileSync'),
            ],
        });
        const ast = program([importDeclaration]);
        expect(() => rejectNodeBuiltinImports(ast, filePath)).toThrow(
            `Importing Node built-in module "fs" is not supported in backend function code`,
        );
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

    const rejectedReExportCases = [
        {
            description: 'reject re-exporting "readFile" from "node:fs" under a new name',
            code: "export { readFile as handler } from 'node:fs';",
            source: 'node:fs',
        },
        {
            description: 'reject re-exporting the bare built-in "fs" without renaming',
            code: "export { readFile } from 'fs';",
            source: 'fs',
        },
    ];

    test.each(rejectedReExportCases)('Should $description', ({ code, source }) => {
        const ast = parseAst(code);
        expect(() => rejectNodeBuiltinImports(ast, filePath)).toThrow(
            `Importing Node built-in module "${source}" is not supported in backend function code`,
        );
        expect(() => rejectNodeBuiltinImports(ast, filePath)).toThrow(filePath);
    });

    test('Should allow re-exporting from a relative module', () => {
        const ast = parseAst("export { helper } from './helpers';");
        expect(() => rejectNodeBuiltinImports(ast, filePath)).not.toThrow();
    });

    test('Should allow a type-only re-export of a Node built-in', () => {
        // export type { Stats } from 'fs';
        const exportDeclaration = exportNamedDecl('fs', { exportKind: 'type' });
        const ast = program([exportDeclaration]);
        expect(() => rejectNodeBuiltinImports(ast, filePath)).not.toThrow();
    });

    test('Should allow an inline type-only named re-export specifier of a Node built-in', () => {
        // export { type Stats } from 'fs';
        const exportDeclaration = exportNamedDecl('fs', {
            specifiers: [exportSpecifier('Stats', { exportKind: 'type' })],
        });
        const ast = program([exportDeclaration]);
        expect(() => rejectNodeBuiltinImports(ast, filePath)).not.toThrow();
    });

    test('Should reject "export * from" a Node built-in', () => {
        const ast = parseAst("export * from 'node:fs';");
        expect(() => rejectNodeBuiltinImports(ast, filePath)).toThrow(
            'Importing Node built-in module "node:fs" is not supported in backend function code',
        );
    });

    test('Should reject "export * as ns from" a Node built-in', () => {
        const ast = parseAst("export * as fs from 'node:fs';");
        expect(() => rejectNodeBuiltinImports(ast, filePath)).toThrow(
            'Importing Node built-in module "node:fs" is not supported in backend function code',
        );
    });

    test('Should allow "export * from" a relative module', () => {
        const ast = parseAst("export * from './helpers';");
        expect(() => rejectNodeBuiltinImports(ast, filePath)).not.toThrow();
    });

    test('Should allow a named export with no source', () => {
        const ast = parseAst('const value = 1;\nexport { value };');
        expect(() => rejectNodeBuiltinImports(ast, filePath)).not.toThrow();
    });

    test('Should reject a literal dynamic import() of a Node built-in', () => {
        const ast = parseAst(
            "export async function run() { const fs = await import('node:fs'); return fs.readFileSync('/etc/passwd'); }",
        );
        expect(() => rejectNodeBuiltinImports(ast, filePath)).toThrow(
            'Importing Node built-in module "node:fs" is not supported in backend function code',
        );
    });

    test('Should allow a literal dynamic import() of a relative module', () => {
        const ast = parseAst(
            "export async function run() { return (await import('./helpers')).helper(); }",
        );
        expect(() => rejectNodeBuiltinImports(ast, filePath)).not.toThrow();
    });

    test('Should allow a non-literal dynamic import(), which cannot be statically checked', () => {
        const ast = parseAst(
            'export async function run(name) { return (await import(name)).default; }',
        );
        expect(() => rejectNodeBuiltinImports(ast, filePath)).not.toThrow();
    });
});
