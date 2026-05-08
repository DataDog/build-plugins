// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Program } from 'estree';
import { parseAst } from 'rollup/parseAst';

import { extractConnectionIds } from './extract-connection-ids';

const filePath = '/project/src/backend/actions.backend.js';

function parse(code: string): Program {
    return parseAst(code) as Program;
}

describe('Backend Functions - extractConnectionIds', () => {
    test('Should extract inline string literal connection IDs from named action-catalog imports', () => {
        const ast = parse(`
            import { request } from '@datadog/action-catalog/http/http';

            export function run() {
                return request({ connectionId: 'conn-b', inputs: {} });
            }
        `);

        expect(extractConnectionIds(ast, filePath)).toEqual(['conn-b']);
    });

    test('Should dedupe and sort connection IDs', () => {
        const ast = parse(`
            import { request } from '@datadog/action-catalog/http/http';

            export function run() {
                request({ connectionId: 'conn-b', inputs: {} });
                request({ connectionId: 'conn-a', inputs: {} });
                request({ connectionId: 'conn-b', inputs: {} });
            }
        `);

        expect(extractConnectionIds(ast, filePath)).toEqual(['conn-a', 'conn-b']);
    });

    test('Should include same-file helper action calls', () => {
        const ast = parse(`
            import { request } from '@datadog/action-catalog/http/http';

            function helper() {
                return request({ connectionId: 'conn-helper', inputs: {} });
            }

            export function run() {
                return helper();
            }
        `);

        expect(extractConnectionIds(ast, filePath)).toEqual(['conn-helper']);
    });

    test('Should detect default and namespace action-catalog imports', () => {
        const ast = parse(`
            import request from '@datadog/action-catalog/http/http';
            import * as slack from '@datadog/action-catalog/slack/messages';

            export function run() {
                request({ connectionId: 'conn-default', inputs: {} });
                slack.postMessage({ connectionId: 'conn-namespace', inputs: {} });
            }
        `);

        expect(extractConnectionIds(ast, filePath)).toEqual(['conn-default', 'conn-namespace']);
    });

    test('Should ignore non-action-catalog calls with connectionId properties', () => {
        const ast = parse(`
            import { request } from './local';

            export function run() {
                request({ connectionId: 'ignored', inputs: {} });
            }
        `);

        expect(extractConnectionIds(ast, filePath)).toEqual([]);
    });

    test('Should ignore action-catalog object arguments without connectionId', () => {
        const ast = parse(`
            import { request } from '@datadog/action-catalog/http/http';

            export function run() {
                request({ inputs: {} });
            }
        `);

        expect(extractConnectionIds(ast, filePath)).toEqual([]);
    });

    test('Should ignore type-only action-catalog imports', () => {
        const ast = parse(`
            import { request } from '@datadog/action-catalog/http/http';

            export function run() {
                request({ connectionId: 'ignored', inputs: {} });
            }
        `);
        const importDeclaration = (ast as unknown as { body: Array<{ importKind?: string }> })
            .body[0];
        // Rollup's parser rejects TypeScript `import type` syntax, so patch the
        // ESTree field that a TypeScript-aware parser would add.
        importDeclaration.importKind = 'type';

        expect(extractConnectionIds(ast, filePath)).toEqual([]);
    });

    test('Should ignore type-only action-catalog import specifiers', () => {
        const ast = parse(`
            import { request } from '@datadog/action-catalog/http/http';

            export function run() {
                request({ connectionId: 'ignored', inputs: {} });
            }
        `);
        const importSpecifier = (
            ast as unknown as {
                body: Array<{ specifiers: Array<{ importKind?: string }> }>;
            }
        ).body[0].specifiers[0];
        // Rollup's parser rejects TypeScript `import { type ... }` syntax, so
        // patch the ESTree field that a TypeScript-aware parser would add.
        importSpecifier.importKind = 'type';

        expect(extractConnectionIds(ast, filePath)).toEqual([]);
    });

    test.each([
        {
            description: 'function parameters that shadow named imports',
            code: `
                import { request } from '@datadog/action-catalog/http/http';

                export function run(request) {
                    return request({ connectionId: 'ignored', inputs: {} });
                }
            `,
        },
        {
            description: 'function parameters that shadow namespace imports',
            code: `
                import * as http from '@datadog/action-catalog/http/http';

                export function run(http) {
                    return http.request({ connectionId: 'ignored', inputs: {} });
                }
            `,
        },
        {
            description: 'catch parameters that shadow named imports',
            code: `
                import { request } from '@datadog/action-catalog/http/http';

                export function run() {
                    try {
                        throw new Error('nope');
                    } catch (request) {
                        request({ connectionId: CONNECTIONS.HTTP, inputs: {} });
                    }
                }
            `,
        },
        {
            description: 'local aliases of shadowed parameters',
            code: `
                import { request } from '@datadog/action-catalog/http/http';

                export function run(request) {
                    const action = request;
                    action({ connectionId: 'ignored', inputs: {} });
                }
            `,
        },
        {
            description: 'for-of bindings that shadow named imports',
            code: `
                import { request } from '@datadog/action-catalog/http/http';

                export function run(handlers) {
                    for (const request of handlers) {
                        request({ connectionId: CONNECTIONS.HTTP, inputs: {} });
                    }
                }
            `,
        },
        {
            description: 'for-statement bindings that shadow named imports',
            code: `
                import { request } from '@datadog/action-catalog/http/http';

                export function run(handlers) {
                    for (const request = handlers.next; request;) {
                        request({ connectionId: CONNECTIONS.HTTP, inputs: {} });
                    }
                }
            `,
        },
        {
            description: 'for-in bindings that shadow namespace imports',
            code: `
                import * as http from '@datadog/action-catalog/http/http';

                export function run(clients) {
                    for (const http in clients) {
                        http.request({ connectionId: CONNECTIONS.HTTP, inputs: {} });
                    }
                }
            `,
        },
    ])(
        'Should not treat shadowed action-catalog import names as action calls: $description',
        ({ code }) => {
            expect(extractConnectionIds(parse(code), filePath)).toEqual([]);
        },
    );

    test.each([
        {
            description: 'identifier value',
            source: 'const ID = "conn"; request({ connectionId: ID, inputs: {} });',
            expectedType: 'Identifier',
        },
        {
            description: 'template literal value',
            source: 'request({ connectionId: `conn`, inputs: {} });',
            expectedType: 'TemplateLiteral',
        },
        {
            description: 'member expression value',
            source: 'request({ connectionId: CONNECTIONS.HTTP, inputs: {} });',
            expectedType: 'MemberExpression',
        },
        {
            description: 'call expression value',
            source: 'request({ connectionId: getConnectionId(), inputs: {} });',
            expectedType: 'CallExpression',
        },
        {
            description: 'binary expression value',
            source: "request({ connectionId: 'conn-' + suffix, inputs: {} });",
            expectedType: 'BinaryExpression',
        },
    ])('Should fail closed for unsupported $description', ({ source, expectedType }) => {
        const ast = parse(`
            import { request } from '@datadog/action-catalog/http/http';

            export function run() {
                ${source}
            }
        `);

        expect(() => extractConnectionIds(ast, filePath)).toThrow(
            `expected an inline string literal, got ${expectedType}`,
        );
    });

    test.each([
        {
            description: 'non-object first arguments',
            source: 'request(opts);',
            expectedMessage: 'non-object action-catalog call arguments',
        },
        {
            description: 'spread-composed object arguments',
            source: 'request({ ...opts });',
            expectedMessage: 'spread object arguments',
        },
        {
            description: 'computed connectionId keys',
            source: "request({ ['connectionId']: 'conn' });",
            expectedMessage: 'computed object property keys',
        },
        {
            description: 'optional action calls',
            source: "request?.({ connectionId: 'conn' });",
            expectedMessage: 'optional action-catalog calls',
        },
        {
            description: 'action-catalog import aliases',
            source: "const action = request; action({ connectionId: 'conn' });",
            expectedMessage: 'action-catalog call aliases',
        },
        {
            description: 'action-catalog namespace member aliases',
            source: "const action = http.request; action({ connectionId: 'conn' });",
            expectedMessage: 'action-catalog call aliases',
            importStatement: "import * as http from '@datadog/action-catalog/http/http';",
        },
        {
            description: 'action-catalog namespace destructuring aliases',
            source: "const { request: action } = http; action({ connectionId: 'conn' });",
            expectedMessage: 'action-catalog call aliases',
            importStatement: "import * as http from '@datadog/action-catalog/http/http';",
        },
        {
            description: 'assigned action-catalog import aliases',
            source: "let action; action = request; action({ connectionId: 'conn' });",
            expectedMessage: 'action-catalog call aliases',
        },
        {
            description: 'assigned action-catalog namespace member aliases',
            source: "let action; action = http.request; action({ connectionId: 'conn' });",
            expectedMessage: 'action-catalog call aliases',
            importStatement: "import * as http from '@datadog/action-catalog/http/http';",
        },
        {
            description: 'assigned action-catalog namespace destructuring aliases',
            source: "let action; ({ request: action } = http); action({ connectionId: 'conn' });",
            expectedMessage: 'action-catalog call aliases',
            importStatement: "import * as http from '@datadog/action-catalog/http/http';",
        },
        {
            description: 'multiple connectionId properties',
            source: "request({ connectionId: 'conn-a', connectionId: 'conn-b' });",
            expectedMessage: 'multiple connectionId properties',
        },
        {
            description: 'accessor connectionId properties',
            source: 'request({ get connectionId() { return CONNECTIONS.HTTP; } });',
            expectedMessage: 'accessor connectionId properties',
        },
        {
            description: 'computed namespace calls',
            source: "http['request']({ connectionId: 'conn' });",
            expectedMessage: 'optional or computed action-catalog namespace calls',
            importStatement: "import * as http from '@datadog/action-catalog/http/http';",
        },
    ])(
        'Should fail closed for unsupported $description',
        ({ source, expectedMessage, importStatement }) => {
            const ast = parse(`
                ${importStatement ?? "import { request } from '@datadog/action-catalog/http/http';"}

                export function run() {
                    ${source}
                }
            `);

            expect(() => extractConnectionIds(ast, filePath)).toThrow(expectedMessage);
        },
    );

    test('Should return an empty allowlist when no connection IDs are present', () => {
        const ast = parse(`
            export function run() {
                return 'ok';
            }
        `);

        expect(extractConnectionIds(ast, filePath)).toEqual([]);
    });
});
