// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { CallExpression, Program } from 'estree';
import { parseAst } from 'rollup/parseAst';

import { collectPatternNames, walkWithScope } from './walk-with-scope';

function parse(code: string): Program {
    return parseAst(code) as Program;
}

function collectCallScopes(code: string, trackedNames: string[]): Record<string, boolean[]> {
    const scopes: Record<string, boolean[]> = {};

    walkWithScope(parse(code), new Set(trackedNames), (node, scope) => {
        if (node.type !== 'CallExpression') {
            return;
        }

        const name = getCallName(node);
        if (!name || !trackedNames.includes(name)) {
            return;
        }

        scopes[name] = [...(scopes[name] ?? []), scope.has(name)];
    });

    return scopes;
}

function getCallName(node: CallExpression): string | undefined {
    if (node.callee.type === 'Identifier') {
        return node.callee.name;
    }
    if (node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier') {
        return node.callee.object.name;
    }
    return undefined;
}

describe('Backend AST parsing - walkWithScope', () => {
    test('Should visit top-level calls without marking tracked imports as shadowed', () => {
        const scopes = collectCallScopes(
            `
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: 'conn' });
            `,
            ['request'],
        );

        expect(scopes).toEqual({ request: [false] });
    });

    test('Should mark function parameters and block declarations as shadowed', () => {
        const scopes = collectCallScopes(
            `
                import { request } from '@datadog/action-catalog/http/http';

                request({ connectionId: 'imported' });

                export function run(request) {
                    request({ connectionId: 'parameter' });
                    {
                        const request = getLocalRequest();
                        request({ connectionId: 'block' });
                    }
                }
            `,
            ['request'],
        );

        expect(scopes).toEqual({ request: [false, true, true] });
    });

    test('Should mark catch and loop bindings as shadowed', () => {
        const scopes = collectCallScopes(
            `
                import { request } from '@datadog/action-catalog/http/http';

                export function run(handlers, clients) {
                    try {
                        throw new Error('nope');
                    } catch (request) {
                        request({ connectionId: 'catch' });
                    }

                    for (const request of handlers) {
                        request({ connectionId: 'for-of' });
                    }

                    for (const request in clients) {
                        request({ connectionId: 'for-in' });
                    }

                    for (const request = handlers.next; request;) {
                        request({ connectionId: 'for' });
                    }
                }
            `,
            ['request'],
        );

        expect(scopes).toEqual({ request: [true, true, true, true] });
    });

    test('Should track namespace object shadowing', () => {
        const scopes = collectCallScopes(
            `
                import * as http from '@datadog/action-catalog/http/http';

                http.request({ connectionId: 'imported' });

                export function run(http) {
                    http.request({ connectionId: 'parameter' });
                }
            `,
            ['http'],
        );

        expect(scopes).toEqual({ http: [false, true] });
    });

    test('Should allow callers to ignore selected variable bindings', () => {
        const scopes: boolean[] = [];

        walkWithScope(
            parse(`
                import { request } from '@datadog/action-catalog/http/http';

                export function run() {
                    const action = request;
                    action({ connectionId: 'alias' });
                }
            `),
            new Set(['request', 'action']),
            (node, scope) => {
                if (
                    node.type === 'CallExpression' &&
                    node.callee.type === 'Identifier' &&
                    node.callee.name === 'action'
                ) {
                    scopes.push(scope.has('action'));
                }
            },
            {
                shouldIgnoreBinding: (name, declaration) =>
                    name === 'action' && declaration.kind === 'variable',
            },
        );

        expect(scopes).toEqual([false]);
    });

    test('Should collect binding names from nested patterns', () => {
        const ast = parse(`
            const {
                client: request,
                nested: { http },
                rest: [firstAction = fallback],
                ...others
            } = value;
        `);
        const declaration = ast.body[0];
        if (declaration.type !== 'VariableDeclaration') {
            throw new Error(`Expected VariableDeclaration, got ${declaration.type}`);
        }

        const [declarator] = declaration.declarations;

        expect(collectPatternNames(declarator.id).sort()).toEqual([
            'firstAction',
            'http',
            'others',
            'request',
        ]);
    });
});
