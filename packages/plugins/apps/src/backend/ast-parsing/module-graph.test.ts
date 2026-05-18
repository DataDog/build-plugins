// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    createParsedModuleRecord,
    type ExportBinding,
    type ImportBinding,
    type ParsedModuleRecord,
    type StaticBinding,
} from './module-graph';
import { parseTestProgram, testBuildRoot } from './test-helpers.test-helper';

function createRecord(code: string, staticDependencies: string[] = []): ParsedModuleRecord {
    const record = createParsedModuleRecord(
        '/project/src/backend/actions.backend.js',
        testBuildRoot,
        parseTestProgram(code),
        staticDependencies,
    );

    if (!record) {
        throw new Error('Expected module record to be created');
    }
    return record;
}

function bindingsByVariableName<T>(bindings: Map<{ name: string }, T>): Record<string, T> {
    return Object.fromEntries(
        [...bindings.entries()].map(([variable, binding]) => [variable.name, binding]),
    );
}

describe('Backend Functions - module graph records', () => {
    test('Should create graph records for app-local backend modules', () => {
        const record = createParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            testBuildRoot,
            parseTestProgram(`
                import { getEcho } from './helpers/http.js';
                export function run() {
                    return getEcho();
                }
            `),
            ['/project/src/backend/helpers/http.js'],
        );

        expect(record).toMatchObject({
            id: '/project/src/backend/actions.backend.js',
            staticDependencies: [
                {
                    source: './helpers/http.js',
                    resolvedId: '/project/src/backend/helpers/http.js',
                },
            ],
            unsupportedDependencies: [],
        });
        expect(record?.ast.type).toBe('Program');
    });

    test('Should pair resolved dependency IDs with static import and export sources', () => {
        const record = createParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            testBuildRoot,
            parseTestProgram(`
                import { getEcho } from './helpers/http.js';
                export { CONNECTION_ID } from './connections.js';
                export * from './shared.js';
            `),
            [
                '/project/src/backend/helpers/http.js',
                '/project/src/backend/connections.js',
                '/project/src/backend/shared.js',
            ],
        );

        expect(record?.staticDependencies).toEqual([
            {
                source: './helpers/http.js',
                resolvedId: '/project/src/backend/helpers/http.js',
            },
            {
                source: './connections.js',
                resolvedId: '/project/src/backend/connections.js',
            },
            {
                source: './shared.js',
                resolvedId: '/project/src/backend/shared.js',
            },
        ]);
    });

    test.each([
        { description: 'package modules', id: '/project/node_modules/package/index.js' },
        { description: 'Yarn package cache modules', id: '/project/.yarn/cache/package/index.js' },
        { description: 'files outside buildRoot', id: '/external/helper.js' },
        { description: 'non-JavaScript files', id: '/project/src/backend/data.json' },
    ])('Should skip $description', ({ id }) => {
        expect(
            createParsedModuleRecord(
                id,
                testBuildRoot,
                parseTestProgram('export const value = true;'),
            ),
        ).toBeNull();
    });

    test.each([
        '/project/src/backend/helper.mts',
        '/project/src/backend/helper.cts',
        '/project/build/helper.js',
        '/project/dist/helper.js',
        '/project/.vite/helper.js',
    ])('Should parse supported app-local module path %s', (id) => {
        expect(
            createParsedModuleRecord(
                id,
                testBuildRoot,
                parseTestProgram('export const value = true;'),
            ),
        ).toEqual(expect.objectContaining({ id }));
    });

    test.each([
        {
            description: 'dynamic local imports',
            code: "import('./helper.js');",
            expected: { kind: 'dynamic-import', specifier: './helper.js' },
        },
        {
            description: 'non-literal dynamic imports',
            code: 'import(helperPath);',
            expected: { kind: 'dynamic-import', specifier: 'non-literal dynamic import' },
        },
        {
            description: 'local require calls',
            code: "require('./helper.js');",
            expected: { kind: 'require', specifier: './helper.js' },
        },
    ])('Should record unsupported $description', ({ code, expected }) => {
        const record = createParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            testBuildRoot,
            parseTestProgram(code),
        );

        expect(record?.unsupportedDependencies).toEqual([expected]);
    });

    test('Should ignore package dynamic imports and require calls', () => {
        const record = createParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            testBuildRoot,
            parseTestProgram(`
                import('package');
                require('package');
            `),
        );

        expect(record?.unsupportedDependencies).toEqual([]);
    });

    test('Should record import bindings by declared variable identity', () => {
        const record = createRecord(
            `
                import { HTTP_ID as ACTIVE_ID } from './ids.js';
                import DEFAULT_ID from './defaults.js';
                import * as namespaceIds from './namespace.js';
            `,
            [
                '/project/src/backend/ids.js',
                '/project/src/backend/defaults.js',
                '/project/src/backend/namespace.js',
            ],
        );

        expect(bindingsByVariableName<ImportBinding>(record.importsByVariable)).toMatchObject({
            ACTIVE_ID: {
                kind: 'named',
                importedName: 'HTTP_ID',
                resolvedId: '/project/src/backend/ids.js',
            },
            DEFAULT_ID: {
                kind: 'default',
                resolvedId: '/project/src/backend/defaults.js',
            },
            namespaceIds: {
                kind: 'namespace',
                resolvedId: '/project/src/backend/namespace.js',
            },
        });
    });

    test('Should record local exports, re-exports, unsupported named exports, and star exports', () => {
        const record = createRecord(
            `
                const LOCAL_ID = 'conn-local';
                const { PATTERN_ID } = runtimeValues;

                export const DIRECT_ID = 'conn-direct';
                export { LOCAL_ID as ACTIVE_ID, PATTERN_ID };
                export { REMOTE_ID as FORWARDED_ID, default as DEFAULT_ID } from './ids.js';
                export * as namespaceIds from './namespace.js';
                export * from './star.js';
                export { LOCAL_ID as default };
            `,
            [
                '/project/src/backend/ids.js',
                '/project/src/backend/namespace.js',
                '/project/src/backend/star.js',
            ],
        );
        const exportsByName = Object.fromEntries(record.exportsByName) as Record<
            string,
            ExportBinding
        >;

        expect(exportsByName.ACTIVE_ID).toMatchObject({ kind: 'local' });
        expect(exportsByName.DIRECT_ID).toMatchObject({ kind: 'local' });
        expect(exportsByName.PATTERN_ID).toMatchObject({ kind: 'local' });
        expect(exportsByName.FORWARDED_ID).toEqual({
            kind: 're-export',
            importedName: 'REMOTE_ID',
            resolvedId: '/project/src/backend/ids.js',
        });
        expect(exportsByName.DEFAULT_ID).toEqual({
            kind: 're-export',
            importedName: 'default',
            resolvedId: '/project/src/backend/ids.js',
        });
        expect(exportsByName.namespaceIds).toEqual({
            kind: 'unsupported',
            reason: 'namespace re-export',
            resolvedId: '/project/src/backend/namespace.js',
        });
        expect(exportsByName.default).toEqual({
            kind: 'unsupported',
            reason: 'default export',
        });
        expect(record.starExports).toEqual([{ resolvedId: '/project/src/backend/star.js' }]);
    });

    test('Should record top-level static bindings by declared variable identity', () => {
        const record = createRecord(`
            const CONST_ID = 'conn-const';
            let MUTABLE_ID = 'conn-mutable';
            const { PATTERN_ID } = ids;
            function getId() {
                return 'conn-function';
            }
            export default function defaultGetId() {
                return 'conn-default-function';
            }
            const CONNECTIONS = { HTTP: 'conn-http' };
            CONNECTIONS.HTTP = 'conn-mutated';
            const DELETED_CONNECTIONS = { HTTP: 'conn-http' };
            delete DELETED_CONNECTIONS.HTTP;
            const FOR_IN_CONNECTIONS = { HTTP: 'conn-http' };
            for (FOR_IN_CONNECTIONS.HTTP in source) {}
            const FOR_OF_CONNECTIONS = { HTTP: 'conn-http' };
            for (FOR_OF_CONNECTIONS.HTTP of source) {}
        `);

        expect(
            bindingsByVariableName<StaticBinding>(record.topLevelBindingsByVariable),
        ).toMatchObject({
            CONST_ID: { kind: 'const' },
            MUTABLE_ID: { kind: 'mutable', declarationKind: 'let' },
            PATTERN_ID: { kind: 'unsupported', reason: 'binding pattern' },
            getId: { kind: 'unsupported', reason: 'FunctionDeclaration binding' },
            defaultGetId: { kind: 'unsupported', reason: 'FunctionDeclaration binding' },
            CONNECTIONS: { kind: 'unsupported', reason: 'mutated object binding' },
            DELETED_CONNECTIONS: { kind: 'unsupported', reason: 'mutated object binding' },
            FOR_IN_CONNECTIONS: { kind: 'unsupported', reason: 'mutated object binding' },
            FOR_OF_CONNECTIONS: { kind: 'unsupported', reason: 'mutated object binding' },
        });
    });
});
