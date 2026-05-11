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
            staticDependencies: ['/project/src/backend/helpers/http.js'],
            unsupportedDependencies: [],
        });
        expect(record?.ast.type).toBe('Program');
    });

    test.each([
        { description: 'package modules', id: '/project/node_modules/package/index.js' },
        { description: 'files outside buildRoot', id: '/external/helper.js' },
        { description: 'dist output', id: '/project/dist/helper.js' },
        { description: 'build output', id: '/project/build/helper.js' },
        { description: 'Vite cache output', id: '/project/.vite/helper.js' },
        { description: 'non-JavaScript files', id: '/project/src/backend/data.json' },
    ])('Should skip $description', ({ id }) => {
        expect(
            createParsedModuleRecord(id, buildRoot, parseAst('export const value = true;')),
        ).toBeNull();
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
