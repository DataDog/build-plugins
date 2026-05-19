// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode, Node, Program } from 'estree';

import { walkAst } from './walk-ast';

describe('Backend AST Parsing - walkAst', () => {
    test('Should visit universal and specialized visitors for ESTree-shaped nodes', () => {
        const ast = buildEstreeFixture();
        const state = {
            visitedTypes: [] as string[],
            callArgumentCounts: [] as number[],
            functionNames: [] as string[],
        };

        walkAst(ast as Node, state, {
            _(node, { state: visitorState }) {
                visitorState.visitedTypes.push(node.type);
            },
            CallExpression(node, { state: visitorState }) {
                visitorState.callArgumentCounts.push(node.arguments.length);
            },
            FunctionDeclaration(node, { state: visitorState }) {
                if (node.id) {
                    visitorState.functionNames.push(node.id.name);
                }
            },
        });

        expect(state.functionNames).toEqual(['run']);
        expect(state.callArgumentCounts).toEqual([1]);
        expect(state.visitedTypes).toEqual(
            expect.arrayContaining([
                'Program',
                'ImportDeclaration',
                'ImportSpecifier',
                'FunctionDeclaration',
                'ObjectPattern',
                'Property',
                'Identifier',
                'BlockStatement',
                'ReturnStatement',
                'CallExpression',
                'MemberExpression',
                'ObjectExpression',
                'Literal',
            ]),
        );
    });

    test('Should traverse arrays and nested node objects in deterministic pre-order', () => {
        const ast = {
            type: 'Root',
            first: { type: 'First' },
            children: [
                { type: 'ChildA' },
                null,
                { not: 'a node' },
                { type: 'ChildB', nested: { type: 'Grandchild' } },
            ],
        } as unknown as TestNode;
        const visited: string[] = [];

        walkAst(
            ast,
            { visited },
            {
                _(node, { state }) {
                    state.visited.push(node.type);
                },
            },
        );

        expect(visited).toEqual(['Root', 'First', 'ChildA', 'ChildB', 'Grandchild']);
    });

    test('Should ignore the type property and non-node objects', () => {
        const ast = {
            type: 'Root',
            metadata: {
                type: 123,
                nestedNodeThatShouldNotBeVisited: { type: 'IgnoredNestedNode' },
            },
            source: {
                value: '@datadog/action-catalog/http/http',
            },
            child: { type: 'VisitedChild' },
        } as unknown as TestNode;
        const visited: string[] = [];

        walkAst(
            ast,
            { visited },
            {
                _(node, { state }) {
                    state.visited.push(node.type);
                },
            },
        );

        expect(visited).toEqual(['Root', 'VisitedChild']);
    });

    test('Should share one state object across all visitors', () => {
        const ast = {
            type: 'Root',
            children: [{ type: 'ChildA' }, { type: 'ChildB' }],
        } as unknown as TestNode;
        const state = { count: 0 };

        walkAst(ast, state, {
            _(_, { state: visitorState }) {
                visitorState.count += 1;
            },
        });

        expect(state.count).toBe(3);
    });
});

type TestNode = BaseNode & {
    first?: TestNode;
    nested?: TestNode;
    child?: TestNode;
    children?: Array<TestNode | null | { not: string }>;
    metadata?: object;
    source?: object;
};

function buildEstreeFixture(): Program {
    return {
        type: 'Program',
        sourceType: 'module',
        body: [
            {
                type: 'ImportDeclaration',
                source: {
                    type: 'Literal',
                    value: '@datadog/action-catalog/http/http',
                },
                attributes: [],
                specifiers: [
                    {
                        type: 'ImportSpecifier',
                        imported: {
                            type: 'Identifier',
                            name: 'request',
                        },
                        local: {
                            type: 'Identifier',
                            name: 'request',
                        },
                    },
                ],
            },
            {
                type: 'FunctionDeclaration',
                id: {
                    type: 'Identifier',
                    name: 'run',
                },
                params: [
                    {
                        type: 'ObjectPattern',
                        properties: [
                            {
                                type: 'Property',
                                kind: 'init',
                                method: false,
                                shorthand: false,
                                computed: false,
                                key: {
                                    type: 'Identifier',
                                    name: 'client',
                                },
                                value: {
                                    type: 'Identifier',
                                    name: 'client',
                                },
                            },
                        ],
                    },
                ],
                body: {
                    type: 'BlockStatement',
                    body: [
                        {
                            type: 'ReturnStatement',
                            argument: {
                                type: 'CallExpression',
                                optional: false,
                                callee: {
                                    type: 'MemberExpression',
                                    optional: false,
                                    computed: false,
                                    object: {
                                        type: 'Identifier',
                                        name: 'http',
                                    },
                                    property: {
                                        type: 'Identifier',
                                        name: 'request',
                                    },
                                },
                                arguments: [
                                    {
                                        type: 'ObjectExpression',
                                        properties: [
                                            {
                                                type: 'Property',
                                                kind: 'init',
                                                method: false,
                                                shorthand: false,
                                                computed: false,
                                                key: {
                                                    type: 'Identifier',
                                                    name: 'connectionId',
                                                },
                                                value: {
                                                    type: 'Literal',
                                                    value: 'conn',
                                                },
                                            },
                                        ],
                                    },
                                ],
                            },
                        },
                    ],
                },
            },
        ],
    };
}
