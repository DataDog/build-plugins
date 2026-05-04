// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { RuleTester } from 'eslint';

import rule from './valid-connections-file';

// ESLint 8 RuleTester uses the legacy `parser` + `parserOptions` shape (string
// path to the parser module, parserOptions at top level), not the v9 flat
// `languageOptions.parser`. The repo's @types/eslint is v9 so the legacy
// shape isn't typed; cast through `unknown` to keep the tests honest about
// runtime. The published plugin also supports v9 flat config at runtime; this
// test only validates the rule logic against the AST shape @typescript-eslint
// /parser produces.
const ruleTester = new RuleTester({
    parser: require.resolve('@typescript-eslint/parser'),
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
} as unknown as ConstructorParameters<typeof RuleTester>[0]);

const filename = 'connections.ts';

ruleTester.run('valid-connections-file', rule, {
    valid: [
        {
            name: 'CONNECTIONS with string-literal values',
            filename,
            code: `export const CONNECTIONS = { OPEN_AI: '00000000-0000-0000-0000-000000000000' } as const;`,
        },
        {
            name: 'template literal without interpolation is allowed',
            filename,
            code: `export const CONNECTIONS = { A: \`abc\` } as const;`,
        },
        {
            name: 'string literal key is allowed',
            filename,
            code: `export const CONNECTIONS = { 'open-ai': 'uuid-1' } as const;`,
        },
        {
            name: 'out-of-scope file is ignored even when malformed',
            filename: 'src/something.ts',
            code: `export const OTHER = makeConnections();`,
        },
    ],
    invalid: [
        {
            name: 'missing CONNECTIONS export',
            filename,
            code: `export const OTHER = { foo: 'bar' } as const;`,
            errors: [{ messageId: 'missingExport' }],
        },
        {
            name: 'lowercase `connections` is not accepted',
            filename,
            code: `export const connections = { foo: 'a' } as const;`,
            errors: [{ messageId: 'missingExport' }],
        },
        {
            name: 'CONNECTIONS not initialized with object literal',
            filename,
            code: `export const CONNECTIONS = makeConnections();`,
            errors: [{ messageId: 'notObjectLiteral' }],
        },
        {
            name: 'duplicate CONNECTIONS exports',
            filename,
            code: `export const CONNECTIONS = { A: 'x' } as const;
export const CONNECTIONS = { B: 'y' } as const;`,
            errors: [{ messageId: 'duplicateExport' }],
        },
        {
            name: 'spread element in CONNECTIONS',
            filename,
            code: `const other = { B: 'y' };
export const CONNECTIONS = { ...other, A: 'x' } as const;`,
            errors: [{ messageId: 'spreadElement' }],
        },
        {
            name: 'computed key in CONNECTIONS',
            filename,
            code: `const k = 'A';
export const CONNECTIONS = { [k]: 'x' } as const;`,
            errors: [{ messageId: 'computedKey' }],
        },
        {
            name: 'value is an identifier (env-like reference)',
            filename,
            code: `declare const ENV_ID: string;
export const CONNECTIONS = { A: ENV_ID } as const;`,
            errors: [
                {
                    messageId: 'valueNotStaticString',
                    data: { key: 'A', valueType: 'Identifier' },
                },
            ],
        },
        {
            name: 'value is a binary expression',
            filename,
            code: `export const CONNECTIONS = { A: 'a' + 'b' } as const;`,
            errors: [
                {
                    messageId: 'valueNotStaticString',
                    data: { key: 'A', valueType: 'BinaryExpression' },
                },
            ],
        },
        {
            name: 'value is a template literal with interpolation',
            filename,
            code: `declare const id: string;
export const CONNECTIONS = { A: \`prefix-\${id}\` } as const;`,
            errors: [
                {
                    messageId: 'templateInterpolation',
                    data: { key: 'A' },
                },
            ],
        },
    ],
});
