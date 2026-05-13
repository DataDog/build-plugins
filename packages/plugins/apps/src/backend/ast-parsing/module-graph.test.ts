// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parseAst } from 'rollup/parseAst';

import { createParsedModuleRecord } from './module-graph';

const buildRoot = '/project';

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
            buildRoot,
            parseAst(`
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
            createParsedModuleRecord(id, buildRoot, parseAst('export const value = true;')),
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
            createParsedModuleRecord(id, buildRoot, parseAst('export const value = true;')),
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
            buildRoot,
            parseAst(code),
        );

        expect(record?.unsupportedDependencies).toEqual([expected]);
    });

    test('Should ignore package dynamic imports and require calls', () => {
        const record = createParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            buildRoot,
            parseAst(`
                import('package');
                require('package');
            `),
        );

        expect(record?.unsupportedDependencies).toEqual([]);
    });
});
