// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { loadsSpecifierThroughIdentifier } from './runtimeLoads';

describe('loadsSpecifierThroughIdentifier', () => {
    const cases = [
        {
            description: 'a dynamic import',
            code: "const id = 'rollup'; await import(id);",
            expected: true,
        },
        {
            description: 'a subpath',
            code: "const id = 'rollup/parseAst'; await import(id);",
            expected: true,
        },
        { description: 'a require', code: "const id = 'rollup'; require(id);", expected: true },
        {
            description: 'require.resolve',
            code: "const id = 'rollup'; require.resolve(id);",
            expected: true,
        },
        {
            description: 'require.resolve with options',
            code: "const id = 'rollup'; require.resolve(id, { paths });",
            expected: true,
        },
        {
            description: 'a type-annotated constant',
            code: "const ROLLUP_ID: string = 'rollup'; await import(ROLLUP_ID);",
            expected: true,
        },
        {
            description: 'a template-literal specifier',
            code: 'const id = `rollup`; await import(id);',
            expected: true,
        },
        {
            description: 'whitespace inside the call',
            code: "const id = 'rollup'; await import( id );",
            expected: true,
        },
        {
            description: 'a $-prefixed minified name',
            code: '$i="rollup";import($i)',
            expected: true,
        },
        {
            description: 'a createRequire alias',
            code: "const id = 'rollup'; const req = createRequire(import.meta.url); req(id);",
            expected: true,
        },
        {
            description: 'another specifier',
            code: "const id = 'vite'; await import(id);",
            expected: false,
        },
        {
            description: 'a package that only starts with the name',
            code: "const id = 'rollup-plugin-esbuild'; await import(id);",
            expected: false,
        },
        {
            description: 'an assignment that is never loaded',
            code: "const id = 'rollup'; console.log(id);",
            expected: false,
        },
        {
            description: 'a method call named import',
            code: "const id = 'rollup'; loader.import(id);",
            expected: false,
        },
    ];

    test.each(cases)('Should return $expected for $description', ({ code, expected }) => {
        const loads = loadsSpecifierThroughIdentifier(code, 'rollup');
        expect(loads).toBe(expected);
    });
});
