// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    BaseNode,
    Identifier,
    MemberExpression,
    Node,
    ObjectExpression,
    Program,
    Property,
    SimpleCallExpression,
    VariableDeclarator,
} from 'estree';
import type { AstNode } from 'rollup';

import { isProgramNode } from './type-guards';
import type { Scope } from './walk-with-scope';
import { collectPatternNames, walkWithScope } from './walk-with-scope';

const ACTION_CATALOG_PACKAGE = '@datadog/action-catalog';
const CONNECTION_ID_PROPERTY = 'connectionId';

interface ActionCatalogImports {
    functions: Set<string>;
    namespaces: Set<string>;
    unsupportedAliases: Set<string>;
}

type NodeWithOptionalImportKind = BaseNode & { importKind?: string };

export function extractConnectionIds(ast: AstNode, filePath: string): string[] {
    if (!isProgramNode(ast)) {
        throw new Error(
            `Expected a Program node from this.parse() for ${filePath}, got ${ast.type}`,
        );
    }

    const imports = collectActionCatalogImports(ast);
    const importedNames = getImportedNames(imports);
    if (importedNames.size === 0) {
        return [];
    }

    collectUnsupportedActionCatalogAliases(ast, imports);

    const connectionIds = new Set<string>();
    walkWithScope(
        ast,
        getTrackedNames(imports),
        (node, scope) => {
            if (node.type !== 'CallExpression') {
                return;
            }

            const actionCall = classifyActionCatalogCall(node, imports, scope, filePath);
            if (!actionCall) {
                return;
            }

            extractConnectionIdFromActionCall(node, filePath, connectionIds);
        },
        {
            shouldIgnoreBinding: (_name, declaration, scope) =>
                declaration.kind === 'variable' &&
                isActionCatalogAliasDeclaration(declaration.node, imports, scope),
        },
    );

    return [...connectionIds].sort();
}

function collectActionCatalogImports(ast: Program): ActionCatalogImports {
    const functions = new Set<string>();
    const namespaces = new Set<string>();
    const unsupportedAliases = new Set<string>();

    for (const node of ast.body) {
        if (node.type !== 'ImportDeclaration' || !isActionCatalogSource(node.source.value)) {
            continue;
        }
        if (isTypeOnly(node)) {
            continue;
        }

        for (const specifier of node.specifiers) {
            if (isTypeOnly(specifier)) {
                continue;
            }

            if (specifier.type === 'ImportNamespaceSpecifier') {
                namespaces.add(specifier.local.name);
            } else {
                functions.add(specifier.local.name);
            }
        }
    }

    return { functions, namespaces, unsupportedAliases };
}

function isActionCatalogSource(source: unknown): boolean {
    return (
        typeof source === 'string' &&
        (source === ACTION_CATALOG_PACKAGE || source.startsWith(`${ACTION_CATALOG_PACKAGE}/`))
    );
}

function isTypeOnly(node: NodeWithOptionalImportKind): boolean {
    return node.importKind === 'type';
}

function classifyActionCatalogCall(
    node: SimpleCallExpression,
    imports: ActionCatalogImports,
    scope: Scope,
    filePath: string,
): boolean {
    const callee = node.callee;

    if (callee.type === 'Identifier') {
        if (imports.unsupportedAliases.has(callee.name) && !scope.has(callee.name)) {
            throw unsupportedActionCatalogCall(filePath, 'action-catalog call aliases');
        }
        if (imports.functions.has(callee.name) && !scope.has(callee.name)) {
            if (node.optional) {
                throw unsupportedActionCatalogCall(filePath, 'optional action-catalog calls');
            }
            return true;
        }
        return false;
    }

    if (callee.type !== 'MemberExpression') {
        return false;
    }

    if (!isNamespaceMember(callee, imports.namespaces, scope)) {
        return false;
    }

    if (node.optional || hasUnsupportedMemberAccess(callee)) {
        throw unsupportedActionCatalogCall(
            filePath,
            'optional or computed action-catalog namespace calls',
        );
    }
    return true;
}

function collectUnsupportedActionCatalogAliases(ast: Program, imports: ActionCatalogImports): void {
    walkWithScope(ast, getImportedNames(imports), (node, scope) => {
        if (node.type !== 'VariableDeclarator') {
            return;
        }

        for (const aliasName of getActionCatalogAliasNames(node, imports, scope)) {
            imports.unsupportedAliases.add(aliasName);
        }
    });
}

function getActionCatalogAliasNames(
    node: VariableDeclarator,
    imports: ActionCatalogImports,
    scope: Scope,
): string[] {
    if (
        node.id.type === 'Identifier' &&
        node.init?.type === 'Identifier' &&
        imports.functions.has(node.init.name) &&
        !scope.has(node.init.name)
    ) {
        return [node.id.name];
    }

    if (
        node.id.type === 'Identifier' &&
        node.init?.type === 'MemberExpression' &&
        isNamespaceMember(node.init, imports.namespaces, scope)
    ) {
        return [node.id.name];
    }

    if (
        node.id.type !== 'ObjectPattern' ||
        node.init?.type !== 'Identifier' ||
        !imports.namespaces.has(node.init.name) ||
        scope.has(node.init.name)
    ) {
        return [];
    }

    return node.id.properties.flatMap((property) => {
        if (property.type === 'RestElement' || property.computed) {
            return [];
        }
        return collectPatternNames(property.value);
    });
}

function isActionCatalogAliasDeclaration(
    node: Node,
    imports: ActionCatalogImports,
    scope: Scope,
): boolean {
    return (
        node.type === 'VariableDeclarator' &&
        getActionCatalogAliasNames(node, imports, scope).length > 0
    );
}

function getImportedNames(imports: ActionCatalogImports): Set<string> {
    return new Set([...imports.functions, ...imports.namespaces]);
}

function getTrackedNames(imports: ActionCatalogImports): Set<string> {
    return new Set([...imports.functions, ...imports.namespaces, ...imports.unsupportedAliases]);
}

function isNamespaceMember(
    node: MemberExpression,
    namespaces: ReadonlySet<string>,
    scope: Scope,
): boolean {
    const root = getMemberExpressionRoot(node);
    return !!root && namespaces.has(root.name) && !scope.has(root.name);
}

function getMemberExpressionRoot(node: MemberExpression): Identifier | undefined {
    if (node.object.type === 'Identifier') {
        return node.object;
    }
    if (node.object.type === 'MemberExpression') {
        return getMemberExpressionRoot(node.object);
    }
    return undefined;
}

function hasUnsupportedMemberAccess(node: MemberExpression): boolean {
    if (node.optional || node.computed) {
        return true;
    }
    return node.object.type === 'MemberExpression' && hasUnsupportedMemberAccess(node.object);
}

function extractConnectionIdFromActionCall(
    node: SimpleCallExpression,
    filePath: string,
    connectionIds: Set<string>,
): void {
    const [firstArg] = node.arguments;
    if (!firstArg || firstArg.type !== 'ObjectExpression') {
        throw unsupportedActionCatalogCall(filePath, 'non-object action-catalog call arguments');
    }

    const connectionIdProperty = findConnectionIdProperty(firstArg, filePath);
    if (!connectionIdProperty) {
        return;
    }

    const { value } = connectionIdProperty;
    if (value.type === 'Literal' && typeof value.value === 'string') {
        connectionIds.add(value.value);
        return;
    }

    throw unsupportedConnectionId(filePath, value.type);
}

function findConnectionIdProperty(
    objectExpression: ObjectExpression,
    filePath: string,
): Property | undefined {
    let connectionIdProperty: Property | undefined;
    for (const property of objectExpression.properties) {
        if (property.type === 'SpreadElement') {
            throw unsupportedActionCatalogCall(filePath, 'spread object arguments');
        }
        if (property.computed) {
            throw unsupportedActionCatalogCall(filePath, 'computed object property keys');
        }
        if (isConnectionIdKey(property)) {
            if (connectionIdProperty) {
                throw unsupportedActionCatalogCall(filePath, 'multiple connectionId properties');
            }
            if (property.kind !== 'init') {
                throw unsupportedActionCatalogCall(filePath, 'accessor connectionId properties');
            }
            connectionIdProperty = property;
        }
    }
    return connectionIdProperty;
}

function isConnectionIdKey(property: Property): boolean {
    if (property.key.type === 'Identifier') {
        return property.key.name === CONNECTION_ID_PROPERTY;
    }
    return property.key.type === 'Literal' && property.key.value === CONNECTION_ID_PROPERTY;
}

function unsupportedActionCatalogCall(filePath: string, unsupported: string): Error {
    return new Error(
        `Unsupported action-catalog call in ${filePath}: ${unsupported} could hide a connectionId.`,
    );
}

function unsupportedConnectionId(filePath: string, type: string): Error {
    return new Error(
        `Unsupported action-catalog connectionId in ${filePath}: expected an inline string literal, got ${type}.`,
    );
}
