// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createFixtureRecord } from '@dd/tests/_jest/helpers/moduleGraph';
import path from 'path';
import { parseAst } from 'rollup/parseAst';

import {
    createParsedModuleRecord,
    type ExportBinding,
    type ImportBinding,
    type ParsedModuleRecord,
    isPackageManagerModule,
    resolveStaticModuleSources,
    shouldTraverseCollectedModule,
    type StaticBinding,
} from './module-graph';
import { ensureProgram } from './type-guards';

const buildRoot = '/project';

const createRecord = (code: string, resolvedIds: string[] = []): ParsedModuleRecord =>
    createFixtureRecord('/project/src/backend/actions.backend.js', buildRoot, code, resolvedIds);

function bindingsByVariableName<T>(bindings: Map<{ name: string }, T>): Record<string, T> {
    return Object.fromEntries(
        [...bindings.entries()].map(([variable, binding]) => [variable.name, binding]),
    );
}

describe('Backend Functions - module graph records', () => {
    test('Should create graph records for app-local backend modules', () => {
        const record = createParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            buildRoot,
            parseAst(`
                import { getEcho } from './helpers/http.js';
                export function run() {
                    return getEcho();
                }
            `),
            [{ source: './helpers/http.js', resolvedId: '/project/src/backend/helpers/http.js' }],
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

    test('Should record the resolved ID of each static import and export source', () => {
        const record = createParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            buildRoot,
            parseAst(`
                import { getEcho } from './helpers/http.js';
                export { CONNECTION_ID } from './connections.js';
                export * from './shared.js';
            `),
            [
                { source: './helpers/http.js', resolvedId: '/project/src/backend/helpers/http.js' },
                { source: './connections.js', resolvedId: '/project/src/backend/connections.js' },
                { source: './shared.js', resolvedId: '/project/src/backend/shared.js' },
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

    test('Should record one dependency per distinct source when a source repeats', () => {
        const record = createRecord(
            `
                import { a } from './x.js';
                import { b } from './y.js';
                import { c } from './x.js';
                import { d } from './z.js';
            `,
            [
                '/project/src/backend/x.js',
                '/project/src/backend/y.js',
                '/project/src/backend/x.js',
                '/project/src/backend/z.js',
            ],
        );

        expect(record.staticDependencies).toEqual([
            { source: './x.js', resolvedId: '/project/src/backend/x.js' },
            { source: './y.js', resolvedId: '/project/src/backend/y.js' },
            { source: './z.js', resolvedId: '/project/src/backend/z.js' },
        ]);
        const bindings = bindingsByVariableName(record.importsByVariable);
        expect(bindings).toMatchObject({
            c: { resolvedId: '/project/src/backend/x.js' },
            d: { resolvedId: '/project/src/backend/z.js' },
        });
    });

    test('Should fail closed when a static source has no resolved ID', () => {
        const ast = parseAst(`
            import { a } from './x.js';
            import { b } from './y.js';
        `);
        const createWithMissingSource = () =>
            createParsedModuleRecord('/project/src/backend/actions.backend.js', buildRoot, ast, [
                { source: './x.js', resolvedId: '/project/src/backend/x.js' },
            ]);
        expect(createWithMissingSource).toThrow(
            'Unsupported local module graph for /project/src/backend/actions.backend.js: static import/export source "./y.js" with no resolved ID could hide an action-catalog connectionId.',
        );
    });

    test.each([
        {
            description: 'a source the module never imports',
            staticDependencies: [
                { source: './x.js', resolvedId: '/project/src/backend/x.js' },
                { source: './unused.js', resolvedId: '/project/src/backend/unused.js' },
            ],
            message: 'resolved ID for "./unused.js"',
        },
        {
            description: 'the same source twice',
            staticDependencies: [
                { source: './x.js', resolvedId: '/project/src/backend/x.js' },
                { source: './x.js', resolvedId: '/project/src/backend/other.js' },
            ],
            message: 'resolved ID for "./x.js"',
        },
    ])(
        'Should fail closed when given a resolved ID for $description',
        ({ staticDependencies, message }) => {
            const ast = parseAst("import { a } from './x.js';");
            const create = () =>
                createParsedModuleRecord(
                    '/project/src/backend/actions.backend.js',
                    buildRoot,
                    ast,
                    staticDependencies,
                );
            expect(create).toThrow(
                `Unsupported local module graph for /project/src/backend/actions.backend.js: ${message}, which isn't a distinct static import/export source, could hide an action-catalog connectionId.`,
            );
        },
    );

    test('Should fail closed when a side-effect import has no resolved ID', () => {
        const ast = parseAst("import './x.js';");
        const create = () =>
            createParsedModuleRecord('/project/src/backend/actions.backend.js', buildRoot, ast, []);
        expect(create).toThrow(
            'Unsupported local module graph for /project/src/backend/actions.backend.js: static import/export source "./x.js" with no resolved ID could hide an action-catalog connectionId.',
        );
    });

    test('Should fail closed when a static source resolves to nothing', async () => {
        const ast = parseAst("import { a } from './x.js';");
        const program = ensureProgram(ast, 'test');
        const resolve = async () => null;

        const resolving = resolveStaticModuleSources(program, '/project/src/a.js', resolve);
        await expect(resolving).rejects.toThrow(
            'Unsupported local module graph for /project/src/a.js: unresolvable import specifier "./x.js" could hide an action-catalog connectionId.',
        );
    });

    test('Should resolve each distinct static source once, in first-occurrence order', async () => {
        const ast = parseAst(`
            import { a } from './x.js';
            export { b } from './y.js';
            import { c } from './x.js';
            export * from './z.js';
        `);
        const program = ensureProgram(ast, 'test');
        const resolve = jest.fn(async (source: string) => `/resolved/${source.slice(2)}`);

        const staticDependencies = await resolveStaticModuleSources(program, 'test', resolve);

        expect(staticDependencies).toEqual([
            { source: './x.js', resolvedId: '/resolved/x.js' },
            { source: './y.js', resolvedId: '/resolved/y.js' },
            { source: './z.js', resolvedId: '/resolved/z.js' },
        ]);
        expect(resolve).toHaveBeenCalledTimes(3);
    });

    test.each([
        { description: 'package modules', id: '/project/node_modules/package/index.js' },
        { description: 'Yarn package cache modules', id: '/project/.yarn/cache/package/index.js' },
        { description: 'files outside buildRoot', id: '/external/helper.js' },
        { description: 'non-JavaScript files', id: '/project/src/backend/data.json' },
    ])('Should skip $description', ({ id }) => {
        const ast = parseAst('export const value = true;');
        const record = createParsedModuleRecord(id, buildRoot, ast, []);
        expect(record).toBeNull();
    });

    test.each([
        '/project/src/backend/helper.mts',
        '/project/src/backend/helper.cts',
        '/project/build/helper.js',
        '/project/dist/helper.js',
        '/project/.vite/helper.js',
    ])('Should parse supported app-local module path %s', (id) => {
        const ast = parseAst('export const value = true;');
        const record = createParsedModuleRecord(id, buildRoot, ast, []);
        const expectedRecord = expect.objectContaining({ id });
        expect(record).toEqual(expectedRecord);
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
        const ast = parseAst(code);
        const record = createParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            buildRoot,
            ast,
            [],
        );

        expect(record?.unsupportedDependencies).toEqual([expected]);
    });

    test('Should ignore package dynamic imports and require calls', () => {
        const ast = parseAst(`
            import('package');
            require('package');
        `);
        const record = createParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            buildRoot,
            ast,
            [],
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

describe('Backend Functions - isPackageManagerModule', () => {
    test.each([
        { modulePath: path.join('node_modules', '@datadog/apps-backend/index.js'), expected: true },
        { modulePath: path.join('..', '..', 'node_modules', 'pkg/index.js'), expected: true },
        { modulePath: path.join('.yarn', 'cache/pkg/index.js'), expected: true },
        { modulePath: path.join('src', 'node_modules_helper.ts'), expected: false },
        { modulePath: path.join('..', 'shared', 'actions.backend.ts'), expected: false },
    ])('Should return $expected for $modulePath', ({ modulePath, expected }) => {
        const isPackage = isPackageManagerModule(modulePath);
        expect(isPackage).toBe(expected);
    });
});

describe('Backend Functions - shouldTraverseCollectedModule', () => {
    test.each([
        {
            description: 'an app module',
            relativeFile: path.join('src', 'helper.ts'),
            expected: true,
        },
        {
            description: 'a module in a `..`-prefixed directory inside the root',
            relativeFile: path.join('..gen', 'helper.ts'),
            expected: true,
        },
        {
            description: 'a module outside the root',
            relativeFile: path.join('..', 'shared', 'helper.ts'),
            expected: false,
        },
        {
            description: 'a package dependency',
            relativeFile: path.join('node_modules', 'pkg', 'index.js'),
            expected: false,
        },
        {
            description: 'a non-code file',
            relativeFile: path.join('src', 'data.json'),
            expected: false,
        },
    ])('Should return $expected for $description', ({ relativeFile, expected }) => {
        const moduleId = path.join(buildRoot, relativeFile);
        const shouldTraverse = shouldTraverseCollectedModule(moduleId, buildRoot);
        expect(shouldTraverse).toBe(expected);
    });
});
