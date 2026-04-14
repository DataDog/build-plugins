// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { discoverBackendFiles, extractExportedFunctions } from '@dd/apps-plugin/backend/discovery';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import type { Program } from 'estree';
import { globSync } from 'glob';

jest.mock('glob');

const log = getMockLogger();
const projectRoot = '/project';

const mockedGlobSync = jest.mocked(globSync);

/**
 * Helper to build a minimal ESTree Program node for testing.
 */
function program(body: Program['body']): Program {
    return { type: 'Program', sourceType: 'module', body };
}

describe('Backend Functions - extractExportedFunctions', () => {
    const filePath = '/project/src/math.backend.ts';

    const cases = [
        {
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
            description: 'discover exported const variables',
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
                                init: null,
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

describe('Backend Functions - discoverBackendFiles', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('Should discover .backend.ts files via glob', () => {
        mockedGlobSync.mockReturnValue([
            '/project/src/utils/mathUtils.backend.ts',
            '/project/src/auth/login.backend.ts',
        ] as any);

        const result = discoverBackendFiles(projectRoot, log);

        expect(result).toEqual([
            {
                absolutePath: '/project/src/utils/mathUtils.backend.ts',
                refPath: 'src/utils/mathUtils',
            },
            {
                absolutePath: '/project/src/auth/login.backend.ts',
                refPath: 'src/auth/login',
            },
        ]);
    });

    test('Should return empty array when no .backend.ts files exist', () => {
        mockedGlobSync.mockReturnValue([]);

        const result = discoverBackendFiles(projectRoot, log);
        expect(result).toEqual([]);
    });

    test('Should strip .backend.{ext} to form the ref path', () => {
        mockedGlobSync.mockReturnValue(['/project/mathUtils.backend.tsx'] as any);

        const result = discoverBackendFiles(projectRoot, log);
        expect(result[0].refPath).toBe('mathUtils');
    });

    test('Should call globSync with correct pattern and options', () => {
        mockedGlobSync.mockReturnValue([]);

        discoverBackendFiles(projectRoot, log);

        expect(mockedGlobSync).toHaveBeenCalledWith('**/*.backend.{ts,tsx,js,jsx}', {
            cwd: projectRoot,
            ignore: ['**/node_modules/**', '**/dist/**', '**/.dist/**'],
            absolute: true,
        });
    });
});
