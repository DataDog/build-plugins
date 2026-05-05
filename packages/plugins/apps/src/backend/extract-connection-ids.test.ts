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
            description: 'identifier',
            expression: 'CONNECTION_ID',
            expectedType: 'Identifier',
        },
        {
            description: 'template literal',
            expression: '`conn-template`',
            expectedType: 'TemplateLiteral',
        },
        {
            description: 'member expression',
            expression: 'CONNECTIONS.HTTP',
            expectedType: 'MemberExpression',
        },
        {
            description: 'call expression',
            expression: 'getConnectionId()',
            expectedType: 'CallExpression',
        },
        {
            description: 'binary expression',
            expression: "'conn-' + suffix",
            expectedType: 'BinaryExpression',
        },
    ])(
        'Should fail closed for unsupported connectionId value expressions: $description',
        ({ expression, expectedType }) => {
            const ast = parseModule(`
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: ${expression} });
            `);

            expect(() => extractConnectionIds(ast, filePath)).toThrow(
                `expected an inline string literal, got ${expectedType}`,
            );
        },
    );
});
