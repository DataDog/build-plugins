// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { extractConnectionIds } from '@dd/apps-plugin/backend/extract-connection-ids';
import { parse } from 'acorn';
import type { ImportDeclaration, Program } from 'estree';
import type { AstNode } from 'rollup';

function parseModule(code: string): AstNode & Program {
    return parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'module',
    }) as unknown as AstNode & Program;
}

describe('Backend Functions - extractConnectionIds', () => {
    const filePath = '/project/src/backend/run.backend.ts';

    test('Should extract sorted and deduped inline string literal connectionIds from same-file calls', () => {
        const ast = parseModule(`
            import { request } from '@datadog/action-catalog/http/http';

            function helper() {
                return request({ connectionId: 'conn-b', inputs: {} });
            }

            export function run() {
                helper();
                request({ connectionId: 'conn-a', inputs: {} });
                request({ connectionId: 'conn-b', inputs: {} });
            }
        `);

        expect(extractConnectionIds(ast, filePath)).toEqual(['conn-a', 'conn-b']);
    });

    test.each([
        {
            description: 'named import from package root',
            code: `
                import { request } from '@datadog/action-catalog';
                request({ connectionId: 'named-root' });
            `,
            expected: ['named-root'],
        },
        {
            description: 'named import from package subpath',
            code: `
                import { request as httpRequest } from '@datadog/action-catalog/http/http';
                httpRequest({ connectionId: 'named-subpath' });
            `,
            expected: ['named-subpath'],
        },
        {
            description: 'default import from package subpath',
            code: `
                import request from '@datadog/action-catalog/http/http';
                request({ connectionId: 'default-subpath' });
            `,
            expected: ['default-subpath'],
        },
        {
            description: 'namespace import from package subpath',
            code: `
                import * as http from '@datadog/action-catalog/http/http';
                http.request({ connectionId: 'namespace-subpath' });
            `,
            expected: ['namespace-subpath'],
        },
    ])('Should detect action-catalog $description', ({ code, expected }) => {
        expect(extractConnectionIds(parseModule(code), filePath)).toEqual(expected);
    });

    test('Should ignore non-action-catalog calls with connectionId', () => {
        const ast = parseModule(`
            import { request } from './local-client';
            request({ connectionId: 'not-action-catalog' });
        `);

        expect(extractConnectionIds(ast, filePath)).toEqual([]);
    });

    test('Should ignore action-catalog object arguments that visibly lack connectionId', () => {
        const ast = parseModule(`
            import { request } from '@datadog/action-catalog/http/http';
            request({ inputs: { verb: 'GET' } });
        `);

        expect(extractConnectionIds(ast, filePath)).toEqual([]);
    });

    test('Should ignore type-only action-catalog imports', () => {
        const ast = parseModule(`
            import { request } from '@datadog/action-catalog/http/http';
            request({ connectionId: 'type-only' });
        `);
        (ast.body[0] as ImportDeclaration & { importKind?: string }).importKind = 'type';

        expect(extractConnectionIds(ast, filePath)).toEqual([]);
    });

    test('Should ignore type-only action-catalog import specifiers', () => {
        const ast = parseModule(`
            import { request } from '@datadog/action-catalog/http/http';
            request({ connectionId: 'type-only-specifier' });
        `);
        const importDeclaration = ast.body[0] as ImportDeclaration;
        (
            importDeclaration.specifiers[0] as ImportDeclaration['specifiers'][number] & {
                importKind?: string;
            }
        ).importKind = 'type';

        expect(extractConnectionIds(ast, filePath)).toEqual([]);
    });

    // This extractor receives the ESTree Program from Rollup's parser; TS-only
    // syntax such as `as const` is outside this helper's parser boundary.
    test.each([
        {
            description: 'same-file const string identifiers',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTION_ID = 'same-file-const';
                request({ connectionId: CONNECTION_ID });
            `,
            expected: ['same-file-const'],
        },
        {
            description: 'exported same-file const string identifiers',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                export const CONNECTION_ID = 'exported-same-file-const';
                request({ connectionId: CONNECTION_ID });
            `,
            expected: ['exported-same-file-const'],
        },
        {
            description: 'same-file const-to-const chains',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const A = 'const-chain';
                const B = A;
                const C = B;
                request({ connectionId: C });
            `,
            expected: ['const-chain'],
        },
        {
            description: 'inline static template literals',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: \`inline-static-template\` });
            `,
            expected: ['inline-static-template'],
        },
        {
            description: 'same-file const static template literals',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTION_ID = \`const-static-template\`;
                request({ connectionId: CONNECTION_ID });
            `,
            expected: ['const-static-template'],
        },
        {
            description: 'same-file const object members with identifier keys',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTIONS = {
                    HTTP: 'object-identifier-key',
                };
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: ['object-identifier-key'],
        },
        {
            description: 'same-file const object members with string-literal keys',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTIONS = {
                    'HTTP': 'object-string-key',
                };
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: ['object-string-key'],
        },
        {
            description: 'same-file const object members whose values are const identifiers',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const HTTP_CONNECTION_ID = 'object-const-value';
                const CONNECTIONS = {
                    HTTP: HTTP_CONNECTION_ID,
                };
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: ['object-const-value'],
        },
    ])('Should resolve $description', ({ code, expected }) => {
        expect(extractConnectionIds(parseModule(code), filePath)).toEqual(expected);
    });

    test.each([
        {
            description: 'non-object first arguments',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request(opts);
            `,
            expected: 'first argument must be an object literal',
        },
        {
            description: 'spread-composed objects',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: 'visible', ...opts });
            `,
            expected: 'object spreads can hide connectionId',
        },
        {
            description: 'computed object keys',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request({ ['connectionId']: 'computed' });
            `,
            expected: 'computed object keys can hide connectionId',
        },
        {
            description: 'optional-chain calls',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request?.({ connectionId: 'optional' });
            `,
            expected: 'optional chaining cannot be statically analyzed',
        },
        {
            description: 'action-catalog import aliases',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const action = request;
                action({ connectionId: 'alias' });
            `,
            expected: 'action-catalog call aliases cannot be statically analyzed',
        },
        {
            description: 'action-catalog namespace destructuring aliases',
            code: `
                import * as http from '@datadog/action-catalog/http/http';
                const { request: action } = http;
                action({ connectionId: 'destructured-alias' });
            `,
            expected: 'action-catalog call aliases cannot be statically analyzed',
        },
        {
            description: 'action-catalog namespace member aliases',
            code: `
                import * as http from '@datadog/action-catalog/http/http';
                const action = http.request;
                action({ connectionId: 'namespace-member-alias' });
            `,
            expected: 'action-catalog call aliases cannot be statically analyzed',
        },
        {
            description: 'computed namespace member calls',
            code: `
                import * as http from '@datadog/action-catalog/http/http';
                http['request']({ connectionId: 'computed-member' });
            `,
            expected: 'computed namespace member calls cannot be statically analyzed',
        },
    ])(
        'Should fail closed for unsupported action-catalog call shapes: $description',
        ({ code, expected }) => {
            expect(() => extractConnectionIds(parseModule(code), filePath)).toThrow(expected);
        },
    );

    test.each([
        {
            description: 'function parameters that shadow named imports',
            code: `
                import { request } from '@datadog/action-catalog/http/http';

                export function run(request) {
                    request({ connectionId: 'shadowed-param' });
                }
            `,
        },
        {
            description: 'function parameters that shadow namespace imports',
            code: `
                import * as http from '@datadog/action-catalog/http/http';

                export function run(http) {
                    http.request({ connectionId: 'shadowed-namespace-param' });
                }
            `,
        },
        {
            description: 'local aliases of shadowed parameters',
            code: `
                import { request } from '@datadog/action-catalog/http/http';

                export function run(request) {
                    const action = request;
                    action({ connectionId: 'shadowed-local-alias' });
                }
            `,
        },
    ])(
        'Should ignore action-catalog import names shadowed by local bindings: $description',
        ({ code }) => {
            expect(extractConnectionIds(parseModule(code), filePath)).toEqual([]);
        },
    );

    test.each([
        {
            description: 'mutable let bindings',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                let CONNECTION_ID = 'mutable-let';
                request({ connectionId: CONNECTION_ID });
            `,
            expected: "declared with 'let'",
        },
        {
            description: 'mutable var bindings',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                var CONNECTION_ID = 'mutable-var';
                request({ connectionId: CONNECTION_ID });
            `,
            expected: "declared with 'var'",
        },
        {
            description: 'unresolved identifiers',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: CONNECTION_ID });
            `,
            expected: "identifier 'CONNECTION_ID' is not a top-level same-file const binding",
        },
        {
            description: 'destructured connection bindings',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTIONS = { HTTP: 'destructured-connection-binding' };
                const { HTTP } = CONNECTIONS;
                request({ connectionId: HTTP });
            `,
            expected: "identifier 'HTTP' is not a top-level same-file const binding",
        },
        {
            description: 'imported identifiers',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                import { CONNECTION_ID } from './connections';
                request({ connectionId: CONNECTION_ID });
            `,
            expected: "imported identifier 'CONNECTION_ID' cannot be statically analyzed",
        },
        {
            description: 'imported object members',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                import { CONNECTIONS } from './connections';
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: "imported object 'CONNECTIONS' cannot be statically analyzed",
        },
        {
            description: 'dynamic template literals',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const prefix = 'conn';
                request({ connectionId: \`\${prefix}-dynamic\` });
            `,
            expected: 'template literals with interpolations cannot be statically analyzed',
        },
        {
            description: 'binary expressions',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: 'conn-' + suffix });
            `,
            expected: 'got BinaryExpression',
        },
        {
            description: 'function calls',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: getConnectionId() });
            `,
            expected: 'got CallExpression',
        },
        {
            description: 'env reads',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: process.env.CONNECTION_ID });
            `,
            expected: 'nested or non-static member expressions cannot be statically analyzed',
        },
        {
            description: 'computed object properties',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const key = 'HTTP';
                const CONNECTIONS = { [key]: 'computed-object-property' };
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: 'computed object properties can hide connectionId object members',
        },
        {
            description: 'object spreads',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const BASE = { HTTP: 'spread-object' };
                const CONNECTIONS = { ...BASE };
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: 'object spreads can hide connectionId object members',
        },
        {
            description: 'nested member chains',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTIONS = { HTTP: { PROD: 'nested-member-chain' } };
                request({ connectionId: CONNECTIONS.HTTP.PROD });
            `,
            expected: 'nested or non-static member expressions cannot be statically analyzed',
        },
        {
            description: 'computed member reads',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTIONS = { HTTP: 'computed-member-read' };
                request({ connectionId: CONNECTIONS['HTTP'] });
            `,
            expected: 'computed member expressions cannot be statically analyzed',
        },
        {
            description: 'object members missing a static property',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTIONS = { SLACK: 'slack-connection' };
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: "object has no static 'HTTP' property",
        },
        {
            description: 'const object aliases',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const BASE = { HTTP: 'aliased-object' };
                const CONNECTIONS = BASE;
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: "object 'CONNECTIONS' must be initialized to an object literal",
        },
    ])(
        'Should fail closed for unsupported connectionId value expressions: $description',
        ({ code, expected }) => {
            expect(() => extractConnectionIds(parseModule(code), filePath)).toThrow(expected);
        },
    );
});
