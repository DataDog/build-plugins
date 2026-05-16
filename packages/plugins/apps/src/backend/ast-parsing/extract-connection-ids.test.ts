// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Program } from 'estree';
import { parseAst } from 'rollup/parseAst';

import { extractConnectionIds } from './extract-connection-ids';
import { createParsedModuleRecord, type ParsedModuleRecord } from './module-graph';

const filePath = '/project/src/backend/actions.backend.js';
const buildRoot = '/project';

function parse(code: string): Program {
    return parseAst(code) as Program;
}

function createRecord(ast: Program): ParsedModuleRecord {
    const record = createParsedModuleRecord(filePath, buildRoot, ast);
    if (!record) {
        throw new Error(`Expected ${filePath} to create a parsed module record`);
    }
    return record;
}

function extract(ast: Program): string[] {
    const record = createRecord(ast);
    return extractConnectionIds(record.ast, filePath, {
        modules: new Map([[record.id, record]]),
        record,
    });
}

describe('Backend Functions - extractConnectionIds', () => {
    test('Should extract inline string literal connection IDs from named action-catalog imports', () => {
        const ast = parse(`
            import { request } from '@datadog/action-catalog/http/http';

            export function run() {
                return request({ connectionId: 'conn-b', inputs: {} });
            }
        `);

        expect(extract(ast)).toEqual(['conn-b']);
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

        expect(extract(ast)).toEqual(['conn-a', 'conn-b']);
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

        expect(extract(ast)).toEqual(['conn-helper']);
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

        expect(extract(ast)).toEqual(['conn-default', 'conn-namespace']);
    });

    test('Should ignore non-action-catalog calls with connectionId properties', () => {
        const ast = parse(`
            import { request } from './local';

            export function run() {
                request({ connectionId: 'ignored', inputs: {} });
            }
        `);

        expect(extract(ast)).toEqual([]);
    });

    test('Should ignore action-catalog object arguments without connectionId', () => {
        const ast = parse(`
            import { request } from '@datadog/action-catalog/http/http';

            export function run() {
                request({ inputs: {} });
            }
        `);

        expect(extract(ast)).toEqual([]);
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

        expect(extract(ast)).toEqual([]);
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

        expect(extract(ast)).toEqual([]);
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
            expect(extract(parse(code))).toEqual([]);
        },
    );

    test.each([
        {
            description: 'same-file const string identifiers',
            code: `
                const HTTP_CONNECTION_ID = 'conn-http';
                export function run() {
                    request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                }
            `,
            expected: ['conn-http'],
        },
        {
            description: 'exported same-file const string identifiers',
            code: `
                export const HTTP_CONNECTION_ID = 'conn-http';
                export function run() {
                    request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                }
            `,
            expected: ['conn-http'],
        },
        {
            description: 'same-file const chains',
            code: `
                const BASE_CONNECTION_ID = 'conn-http';
                const HTTP_CONNECTION_ID = BASE_CONNECTION_ID;
                export function run() {
                    request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                }
            `,
            expected: ['conn-http'],
        },
        {
            description: 'same-file const template literal identifiers',
            code: `
                const HTTP_CONNECTION_ID = \`conn-http\`;
                export function run() {
                    request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                }
            `,
            expected: ['conn-http'],
        },
        {
            description: 'static template literals',
            code: `
                export function run() {
                    request({ connectionId: \`conn-http\`, inputs: {} });
                }
            `,
            expected: ['conn-http'],
        },
        {
            description: 'same-file const object member reads',
            code: `
                const CONNECTIONS = { HTTP: 'conn-http' };
                export function run() {
                    request({ connectionId: CONNECTIONS.HTTP, inputs: {} });
                }
            `,
            expected: ['conn-http'],
        },
        {
            description: 'same-file const object member values that reference const strings',
            code: `
                const HTTP_CONNECTION_ID = 'conn-http';
                const CONNECTIONS = { HTTP: HTTP_CONNECTION_ID };
                export function run() {
                    request({ connectionId: CONNECTIONS.HTTP, inputs: {} });
                }
            `,
            expected: ['conn-http'],
        },
        {
            description: 'same-file const object member reads with string-literal keys',
            code: `
                const CONNECTIONS = { 'HTTP': 'conn-http' };
                export function run() {
                    request({ connectionId: CONNECTIONS.HTTP, inputs: {} });
                }
            `,
            expected: ['conn-http'],
        },
        {
            description: 'same-file const nested object member reads',
            code: `
                const CONNECTIONS = { HTTP: { PROD: 'conn-http' } };
                export function run() {
                    request({ connectionId: CONNECTIONS.HTTP.PROD, inputs: {} });
                }
            `,
            expected: ['conn-http'],
        },
        {
            description: 'same-file const deeply nested object member reads',
            code: `
                const CONNECTIONS = { HTTP: { PROD: { US1: 'conn-http' } } };
                export function run() {
                    request({ connectionId: CONNECTIONS.HTTP.PROD.US1, inputs: {} });
                }
            `,
            expected: ['conn-http'],
        },
        {
            description: 'same-file const nested object aliases',
            code: `
                const HTTP = { PROD: 'conn-http' };
                const CONNECTIONS = { HTTP };
                export function run() {
                    request({ connectionId: CONNECTIONS.HTTP.PROD, inputs: {} });
                }
            `,
            expected: ['conn-http'],
        },
        {
            description: 'same-file helper action calls with const connection values',
            code: `
                const HTTP_CONNECTION_ID = 'conn-http';
                function helper() {
                    return request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                }
                export function run() {
                    return helper();
                }
            `,
            expected: ['conn-http'],
        },
    ])('Should extract $description', ({ code, expected }) => {
        const ast = parse(`
            import { request } from '@datadog/action-catalog/http/http';
            ${code}
        `);

        expect(extract(ast)).toEqual(expected);
    });

    test.each([
        {
            description: 'call expression value',
            code: `
                export function run() {
                    request({ connectionId: getConnectionId(), inputs: {} });
                }
            `,
            expectedMessage: 'unsupported CallExpression values',
        },
        {
            description: 'binary expression value',
            code: `
                export function run() {
                    request({ connectionId: 'conn-' + suffix, inputs: {} });
                }
            `,
            expectedMessage: 'unsupported BinaryExpression values',
        },
        {
            description: 'mutable let bindings',
            code: `
                let ID = 'conn';
                export function run() {
                    request({ connectionId: ID, inputs: {} });
                }
            `,
            expectedMessage: 'unsupported static definition mutable-binding',
        },
        {
            description: 'mutable var bindings',
            code: `
                var ID = 'conn';
                export function run() {
                    request({ connectionId: ID, inputs: {} });
                }
            `,
            expectedMessage: 'unsupported static definition mutable-binding',
        },
        {
            description: 'unresolved identifiers',
            code: `
                export function run() {
                    request({ connectionId: ID, inputs: {} });
                }
            `,
            expectedMessage: 'unsupported static definition unresolved-identifier',
        },
        {
            description: 'function-local const bindings',
            code: `
                export function run() {
                    const ID = 'conn';
                    request({ connectionId: ID, inputs: {} });
                }
            `,
            expectedMessage: 'unsupported static definition missing-static-binding',
        },
        {
            description: 'imported identifiers',
            code: `
                import { ID } from './connections';
                export function run() {
                    request({ connectionId: ID, inputs: {} });
                }
            `,
            expectedMessage: 'unsupported static definition missing-module-record',
        },
        {
            description: 'imported object member reads',
            code: `
                import { CONNECTIONS } from './connections';
                export function run() {
                    request({ connectionId: CONNECTIONS.HTTP, inputs: {} });
                }
            `,
            expectedMessage: 'unsupported static definition missing-module-record',
        },
        {
            description: 'dynamic template literals',
            code: `
                export function run() {
                    request({ connectionId: \`\${prefix}-conn\`, inputs: {} });
                }
            `,
            expectedMessage: 'dynamic template literals',
        },
        {
            description: 'computed connectionId member reads',
            code: `
                const CONNECTIONS = { HTTP: 'conn' };
                export function run() {
                    request({ connectionId: CONNECTIONS['HTTP'], inputs: {} });
                }
            `,
            expectedMessage: 'computed connectionId member reads',
        },
        {
            description: 'object spreads in connectionId objects',
            code: `
                const BASE = { HTTP: 'conn' };
                const CONNECTIONS = { ...BASE };
                export function run() {
                    request({ connectionId: CONNECTIONS.HTTP, inputs: {} });
                }
            `,
            expectedMessage: 'object spreads in connectionId objects',
        },
        {
            description: 'computed properties in connectionId objects',
            code: `
                const key = 'HTTP';
                const CONNECTIONS = { [key]: 'conn' };
                export function run() {
                    request({ connectionId: CONNECTIONS.HTTP, inputs: {} });
                }
            `,
            expectedMessage: 'computed properties in connectionId objects',
        },
        {
            description: 'member reads through non-object intermediate values',
            code: `
                const CONNECTIONS = { HTTP: 'conn' };
                export function run() {
                    request({ connectionId: CONNECTIONS.HTTP.PROD, inputs: {} });
                }
            `,
            expectedMessage: 'non-object connectionId member values',
        },
        {
            description: 'object spreads in nested connectionId objects',
            code: `
                const BASE = { PROD: 'conn' };
                const CONNECTIONS = { HTTP: { ...BASE } };
                export function run() {
                    request({ connectionId: CONNECTIONS.HTTP.PROD, inputs: {} });
                }
            `,
            expectedMessage: 'object spreads in connectionId objects',
        },
        {
            description: 'computed properties in nested connectionId objects',
            code: `
                const key = 'PROD';
                const CONNECTIONS = { HTTP: { [key]: 'conn' } };
                export function run() {
                    request({ connectionId: CONNECTIONS.HTTP.PROD, inputs: {} });
                }
            `,
            expectedMessage: 'computed properties in connectionId objects',
        },
        {
            description: 'environment reads',
            code: `
                export function run() {
                    request({ connectionId: process.env.ID, inputs: {} });
                }
            `,
            expectedMessage: 'unsupported static definition unresolved-identifier',
        },
        {
            description: 'const cycles',
            code: `
                const A = B;
                const B = A;
                export function run() {
                    request({ connectionId: A, inputs: {} });
                }
            `,
            expectedMessage: 'cyclic connectionId binding A',
        },
    ])('Should fail closed for unsupported $description', ({ code, expectedMessage }) => {
        const ast = parse(`
            import { request } from '@datadog/action-catalog/http/http';
            ${code}
        `);

        expect(() => extract(ast)).toThrow(expectedMessage);
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

            expect(() => extract(ast)).toThrow(expectedMessage);
        },
    );

    test('Should return an empty allowlist when no connection IDs are present', () => {
        const ast = parse(`
            export function run() {
                return 'ok';
            }
        `);

        expect(extract(ast)).toEqual([]);
    });
});
