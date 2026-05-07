// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    ArrowFunctionExpression,
    BlockStatement,
    CatchClause,
    ForInStatement,
    ForOfStatement,
    ForStatement,
    FunctionDeclaration,
    FunctionExpression,
    Node,
    Pattern,
    Program,
    Statement,
    VariableDeclaration,
} from 'estree';

export type Scope = ReadonlySet<string>;

export type BindingDeclaration =
    | { kind: 'catch-param'; node: Node }
    | { kind: 'class'; node: Node }
    | { kind: 'for-left'; node: Node }
    | { kind: 'function'; node: Node }
    | { kind: 'function-param'; node: Node }
    | { kind: 'variable'; node: Node };

export interface WalkWithScopeOptions {
    shouldIgnoreBinding?: (name: string, declaration: BindingDeclaration, scope: Scope) => boolean;
}

export function walkWithScope(
    program: Program,
    trackedNames: ReadonlySet<string>,
    visit: (node: Node, scope: Scope) => void,
    options: WalkWithScopeOptions = {},
): void {
    walkNode(program, new Set(), trackedNames, visit, options);
}

function walkProgram(
    program: Program,
    scope: Scope,
    trackedNames: ReadonlySet<string>,
    visit: (node: Node, scope: Scope) => void,
    options: WalkWithScopeOptions,
): void {
    for (const statement of program.body) {
        walkNode(statement, scope, trackedNames, visit, options);
    }
}

function walkBlockStatement(
    block: BlockStatement,
    scope: Scope,
    trackedNames: ReadonlySet<string>,
    visit: (node: Node, scope: Scope) => void,
    options: WalkWithScopeOptions,
): void {
    const blockScope = addShadowedNames(
        scope,
        collectStatementDeclarations(block.body),
        trackedNames,
        options,
    );
    for (const statement of block.body) {
        walkNode(statement, blockScope, trackedNames, visit, options);
    }
}

function walkFunction(
    node: FunctionDeclaration | FunctionExpression | ArrowFunctionExpression,
    scope: Scope,
    trackedNames: ReadonlySet<string>,
    visit: (node: Node, scope: Scope) => void,
    options: WalkWithScopeOptions,
): void {
    const functionBindings = node.params.flatMap((param): BindingName[] =>
        collectPatternBindingNames(param, { kind: 'function-param', node: param }),
    );
    if ('id' in node && node.id) {
        functionBindings.push({
            name: node.id.name,
            declaration: { kind: 'function', node: node.id },
        });
    }

    const functionScope = addShadowedNames(scope, functionBindings, trackedNames, options);
    if (node.body.type === 'BlockStatement') {
        walkBlockStatement(node.body, functionScope, trackedNames, visit, options);
    } else {
        walkNode(node.body, functionScope, trackedNames, visit, options);
    }
}

function walkCatchClause(
    node: CatchClause,
    scope: Scope,
    trackedNames: ReadonlySet<string>,
    visit: (node: Node, scope: Scope) => void,
    options: WalkWithScopeOptions,
): void {
    const catchScope = node.param
        ? addShadowedNames(
              scope,
              collectPatternBindingNames(node.param, {
                  kind: 'catch-param',
                  node: node.param,
              }),
              trackedNames,
              options,
          )
        : scope;
    walkBlockStatement(node.body, catchScope, trackedNames, visit, options);
}

function walkForStatement(
    node: ForStatement,
    scope: Scope,
    trackedNames: ReadonlySet<string>,
    visit: (node: Node, scope: Scope) => void,
    options: WalkWithScopeOptions,
): void {
    const loopScope =
        node.init?.type === 'VariableDeclaration'
            ? addShadowedNames(
                  scope,
                  collectVariableDeclarationBindings(node.init, 'for-left'),
                  trackedNames,
                  options,
              )
            : scope;

    if (node.init) {
        walkNode(node.init, loopScope, trackedNames, visit, options);
    }
    if (node.test) {
        walkNode(node.test, loopScope, trackedNames, visit, options);
    }
    if (node.update) {
        walkNode(node.update, loopScope, trackedNames, visit, options);
    }

    walkNode(node.body, loopScope, trackedNames, visit, options);
}

function walkForInOrOfStatement(
    node: ForInStatement | ForOfStatement,
    scope: Scope,
    trackedNames: ReadonlySet<string>,
    visit: (node: Node, scope: Scope) => void,
    options: WalkWithScopeOptions,
): void {
    const leftBindings =
        node.left.type === 'VariableDeclaration'
            ? collectVariableDeclarationBindings(node.left, 'for-left')
            : collectPatternBindingNames(node.left, { kind: 'for-left', node: node.left });
    const loopScope = addShadowedNames(scope, leftBindings, trackedNames, options);
    walkNode(node.right, loopScope, trackedNames, visit, options);
    walkNode(node.body, loopScope, trackedNames, visit, options);
}

function walkNode(
    node: Node,
    scope: Scope,
    trackedNames: ReadonlySet<string>,
    visit: (node: Node, scope: Scope) => void,
    options: WalkWithScopeOptions,
): void {
    visit(node, scope);

    switch (node.type) {
        case 'Program':
            walkProgram(node, scope, trackedNames, visit, options);
            return;
        case 'BlockStatement':
            walkBlockStatement(node, scope, trackedNames, visit, options);
            return;
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
            walkFunction(node, scope, trackedNames, visit, options);
            return;
        case 'CatchClause':
            walkCatchClause(node, scope, trackedNames, visit, options);
            return;
        case 'ForStatement':
            walkForStatement(node, scope, trackedNames, visit, options);
            return;
        case 'ForInStatement':
        case 'ForOfStatement':
            walkForInOrOfStatement(node, scope, trackedNames, visit, options);
            return;
        case 'ImportDeclaration':
            return;
        default:
            walkChildNodes(node, scope, trackedNames, visit, options);
    }
}

function walkChildNodes(
    node: Node,
    scope: Scope,
    trackedNames: ReadonlySet<string>,
    visit: (node: Node, scope: Scope) => void,
    options: WalkWithScopeOptions,
): void {
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const child of value) {
                if (isNode(child)) {
                    walkNode(child, scope, trackedNames, visit, options);
                }
            }
        } else if (isNode(value)) {
            walkNode(value, scope, trackedNames, visit, options);
        }
    }
}

interface BindingName {
    name: string;
    declaration: BindingDeclaration;
}

function addShadowedNames(
    scope: Scope,
    bindings: BindingName[],
    trackedNames: ReadonlySet<string>,
    options: WalkWithScopeOptions,
): Scope {
    const shadowed = bindings
        .filter(
            ({ name, declaration }) =>
                trackedNames.has(name) && !options.shouldIgnoreBinding?.(name, declaration, scope),
        )
        .map(({ name }) => name);
    if (shadowed.length === 0) {
        return scope;
    }
    return new Set([...scope, ...shadowed]);
}

function collectStatementDeclarations(statements: Statement[]): BindingName[] {
    const names: BindingName[] = [];
    for (const statement of statements) {
        if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
            if (statement.id) {
                names.push({
                    name: statement.id.name,
                    declaration: {
                        kind: statement.type === 'FunctionDeclaration' ? 'function' : 'class',
                        node: statement.id,
                    },
                });
            }
        } else if (statement.type === 'VariableDeclaration') {
            names.push(...collectVariableDeclarationBindings(statement, 'variable'));
        }
    }
    return names;
}

function collectVariableDeclarationBindings(
    declaration: VariableDeclaration,
    kind: 'for-left' | 'variable',
): BindingName[] {
    return declaration.declarations.flatMap((declarator) =>
        collectPatternBindingNames(declarator.id, { kind, node: declarator }),
    );
}

export function collectPatternNames(pattern: Pattern): string[] {
    return collectPatternBindingNames(pattern, { kind: 'variable', node: pattern }).map(
        ({ name }) => name,
    );
}

function collectPatternBindingNames(
    pattern: Pattern,
    declaration: BindingDeclaration,
): BindingName[] {
    switch (pattern.type) {
        case 'Identifier':
            return [{ name: pattern.name, declaration }];
        case 'ObjectPattern':
            return pattern.properties.flatMap((property) => {
                if (property.type === 'RestElement') {
                    return collectPatternBindingNames(property.argument, declaration);
                }
                return collectPatternBindingNames(property.value, declaration);
            });
        case 'ArrayPattern':
            return pattern.elements.flatMap((element) =>
                element ? collectPatternBindingNames(element, declaration) : [],
            );
        case 'RestElement':
            return collectPatternBindingNames(pattern.argument, declaration);
        case 'AssignmentPattern':
            return collectPatternBindingNames(pattern.left, declaration);
        case 'MemberExpression':
            return [];
    }
}

function isNode(value: unknown): value is Node {
    return (
        typeof value === 'object' &&
        value !== null &&
        'type' in value &&
        typeof (value as { type?: unknown }).type === 'string'
    );
}
