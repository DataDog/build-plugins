// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    CallExpression,
    Expression,
    ImportDeclaration,
    ImportSpecifier,
    MemberExpression,
    Node,
    ObjectExpression,
    Program,
    Property,
    Statement,
    Super,
    TemplateLiteral,
    VariableDeclaration,
    VariableDeclarator,
} from 'estree';
import type { AstNode } from 'rollup';

const ACTION_CATALOG_PACKAGE = '@datadog/action-catalog';
const MAX_CONST_RESOLUTION_DEPTH = 32;

type MutableKind = 'let' | 'var';

interface ActionCatalogImports {
    functions: Set<string>;
    namespaces: Set<string>;
    unsupportedAliases: Set<string>;
}

interface SameModuleBindings {
    consts: Map<string, Expression>;
    mutables: Map<string, MutableKind>;
    importedIdentifiers: Set<string>;
    importedNamespaces: Set<string>;
}

class ConnectionIdExtractionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConnectionIdExtractionError';
    }
}

/**
 * Extracts inline action-catalog connection IDs from one backend module AST.
 */
export function extractConnectionIds(ast: AstNode, filePath: string): string[] {
    // Rollup's this.parse(code) should return the module root for code like
    // `import { request } from '@datadog/action-catalog/http/http';`.
    if (!isProgramNode(ast)) {
        throw new Error(
            `Expected a Program node from this.parse() for ${filePath}, got ${ast.type}`,
        );
    }

    const actionImports = collectActionCatalogImports(ast);
    const bindings = collectSameModuleBindings(ast);
    const ids = new Set<string>();

    walkWithScope(ast, actionImports, (node, shadowedBindings) => {
        // Only call sites such as `request({ connectionId: 'abc' })` can
        // contain backend action connection IDs.
        if (node.type !== 'CallExpression') {
            return;
        }
        failIfUnsupportedActionCatalogCallee(
            node.callee,
            actionImports,
            shadowedBindings,
            filePath,
        );
        if (!isActionCatalogCallee(node.callee, actionImports, shadowedBindings)) {
            return;
        }

        for (const id of extractIdsFromActionCatalogCall(node, bindings, filePath)) {
            ids.add(id);
        }
    });

    return [...ids].sort();
}

/**
 * Narrows a Rollup AST node to the ESTree module root produced by this.parse().
 */
function isProgramNode(node: AstNode): node is AstNode & Program {
    return node.type === 'Program';
}

/**
 * Reports whether a whole import declaration is type-only.
 */
function isTypeOnlyImport(node: ImportDeclaration): boolean {
    return (node as ImportDeclaration & { importKind?: string }).importKind === 'type';
}

/**
 * Reports whether a named import specifier is type-only.
 */
function isTypeOnlyImportSpecifier(node: ImportSpecifier): boolean {
    return (node as ImportSpecifier & { importKind?: string }).importKind === 'type';
}

/**
 * Reports whether an import source belongs to the action-catalog package.
 */
function isActionCatalogSource(source: string): boolean {
    return source === ACTION_CATALOG_PACKAGE || source.startsWith(`${ACTION_CATALOG_PACKAGE}/`);
}

/**
 * Reports whether a variable declaration kind can be reassigned.
 */
function isMutableKind(kind: string): kind is MutableKind {
    return kind === 'let' || kind === 'var';
}

/**
 * Collects top-level same-module bindings used to resolve connectionId expressions.
 */
function collectSameModuleBindings(ast: Program): SameModuleBindings {
    const consts = new Map<string, Expression>();
    const mutables = new Map<string, MutableKind>();
    const importedIdentifiers = new Set<string>();
    const importedNamespaces = new Set<string>();

    for (const node of ast.body) {
        if (node.type === 'VariableDeclaration') {
            recordVariableDeclaration(node, consts, mutables);
        } else if (
            node.type === 'ExportNamedDeclaration' &&
            node.declaration?.type === 'VariableDeclaration'
        ) {
            recordVariableDeclaration(node.declaration, consts, mutables);
        } else if (
            node.type === 'ImportDeclaration' &&
            !isTypeOnlyImport(node) &&
            typeof node.source.value === 'string'
        ) {
            for (const spec of node.specifiers) {
                if (spec.type === 'ImportSpecifier') {
                    if (!isTypeOnlyImportSpecifier(spec)) {
                        importedIdentifiers.add(spec.local.name);
                    }
                } else if (spec.type === 'ImportDefaultSpecifier') {
                    importedIdentifiers.add(spec.local.name);
                } else if (spec.type === 'ImportNamespaceSpecifier') {
                    importedNamespaces.add(spec.local.name);
                }
            }
        }
    }

    return { consts, mutables, importedIdentifiers, importedNamespaces };
}

/**
 * Records top-level const values and mutable names from one variable declaration.
 */
function recordVariableDeclaration(
    declaration: VariableDeclaration,
    consts: Map<string, Expression>,
    mutables: Map<string, MutableKind>,
): void {
    for (const declarator of declaration.declarations) {
        if (declarator.id.type !== 'Identifier') {
            continue;
        }
        if (declaration.kind === 'const' && declarator.init) {
            consts.set(declarator.id.name, declarator.init);
        } else if (isMutableKind(declaration.kind)) {
            mutables.set(declarator.id.name, declaration.kind);
        }
    }
}

/**
 * Collects action-catalog function imports, namespace imports, and unsupported local aliases.
 */
function collectActionCatalogImports(ast: Program): ActionCatalogImports {
    const functions = new Set<string>();
    const namespaces = new Set<string>();
    const unsupportedAliases = new Set<string>();

    for (const node of ast.body) {
        // Keep only action-catalog imports like
        // `import { request } from '@datadog/action-catalog/http/http';`.
        if (
            node.type !== 'ImportDeclaration' ||
            isTypeOnlyImport(node) ||
            typeof node.source.value !== 'string' ||
            !isActionCatalogSource(node.source.value)
        ) {
            continue;
        }

        for (const spec of node.specifiers) {
            // `import { request as httpRequest } from '...'`
            if (spec.type === 'ImportSpecifier') {
                if (!isTypeOnlyImportSpecifier(spec)) {
                    functions.add(spec.local.name);
                }
                // `import request from '@datadog/action-catalog/http/http'`
            } else if (spec.type === 'ImportDefaultSpecifier') {
                functions.add(spec.local.name);
                // `import * as http from '@datadog/action-catalog/http/http'`
            } else if (spec.type === 'ImportNamespaceSpecifier') {
                namespaces.add(spec.local.name);
            }
        }
    }

    walkWithScope(ast, { functions, namespaces, unsupportedAliases }, (node, shadowedBindings) => {
        // Aliases are introduced through declarations like `const action = request`.
        if (node.type !== 'VariableDeclarator') {
            return;
        }
        // `const action = request` aliases a named/default action import.
        if (
            node.id.type === 'Identifier' &&
            node.init?.type === 'Identifier' &&
            functions.has(node.init.name) &&
            !shadowedBindings.has(node.init.name)
        ) {
            unsupportedAliases.add(node.id.name);
            return;
        }
        // `const action = http.request` aliases a namespace action import.
        if (
            node.id.type === 'Identifier' &&
            node.init?.type === 'MemberExpression' &&
            isNamespaceMember(node.init, namespaces, shadowedBindings)
        ) {
            unsupportedAliases.add(node.id.name);
            return;
        }
        // `const { request: action } = http` aliases a namespace action import.
        if (
            node.id.type !== 'ObjectPattern' ||
            node.init?.type !== 'Identifier' ||
            !namespaces.has(node.init.name) ||
            shadowedBindings.has(node.init.name)
        ) {
            return;
        }
        for (const prop of node.id.properties) {
            // In `const { request: action } = http`, `action` is the local binding.
            if (prop.type !== 'Property' || prop.computed) {
                continue;
            }
            if (prop.value.type === 'Identifier') {
                unsupportedAliases.add(prop.value.name);
            }
        }
    });

    return { functions, namespaces, unsupportedAliases };
}

/**
 * Extracts connection IDs from a statically analyzable action-catalog call.
 */
function extractIdsFromActionCatalogCall(
    call: CallExpression,
    bindings: SameModuleBindings,
    filePath: string,
): string[] {
    failIfOptionalActionCatalogCall(call, filePath);

    const firstArg = call.arguments[0];
    // Support `request({ connectionId: 'abc' })`; reject `request(options)`.
    if (!firstArg || firstArg.type !== 'ObjectExpression') {
        fail(
            `Unsupported action-catalog call in ${filePath}: the first argument must be an object literal so connectionId can be statically analyzed.`,
        );
    }

    const connectionIdValue = findConnectionIdValue(firstArg, filePath);
    if (!connectionIdValue) {
        return [];
    }
    // In PR #340, this same ESTree node can be an inline string
    // `{ connectionId: 'abc' }` or a same-file const like `CONNECTIONS.HTTP`.
    return [resolveConnectionIdValue(connectionIdValue, bindings, filePath)];
}

/**
 * Fails when an action-catalog call uses optional chaining that can hide the invoked callee.
 */
function failIfOptionalActionCatalogCall(call: CallExpression, filePath: string): void {
    // `request?.({ connectionId: 'abc' })` and `http?.request(...)` can hide
    // which callee is actually invoked.
    if (isOptionalNode(call) || containsOptionalMember(call.callee)) {
        fail(
            `Unsupported action-catalog call in ${filePath}: optional chaining cannot be statically analyzed for connectionId.`,
        );
    }
}

/**
 * Finds the visible connectionId property value in an object-literal call argument.
 */
function findConnectionIdValue(obj: ObjectExpression, filePath: string): Expression | undefined {
    let connectionIdValue: Expression | undefined;
    for (const prop of obj.properties) {
        // `{ connectionId: 'visible', ...opts }` can be overwritten by `opts`.
        if (prop.type === 'SpreadElement') {
            fail(
                `Unsupported action-catalog call in ${filePath}: object spreads can hide connectionId.`,
            );
        }
        // ObjectExpression also allows spread elements; only key/value
        // properties like `{ connectionId: 'abc' }` are useful here.
        if (prop.type !== 'Property') {
            continue;
        }
        // `{ ['connectionId']: 'abc' }` is intentionally rejected so the key
        // is visible without evaluating JavaScript.
        if (prop.computed) {
            fail(
                `Unsupported action-catalog call in ${filePath}: computed object keys can hide connectionId.`,
            );
        }
        // Match both `{ connectionId: 'abc' }` and `{ 'connectionId': 'abc' }`.
        if (isConnectionIdProperty(prop)) {
            if (connectionIdValue) {
                fail(
                    `Unsupported action-catalog call in ${filePath}: multiple connectionId properties cannot be statically analyzed.`,
                );
            }
            connectionIdValue = prop.value as Expression;
        }
    }
    return connectionIdValue;
}

/**
 * Reports whether an object property key is the static connectionId key.
 */
function isConnectionIdProperty(prop: Property): boolean {
    // Identifier key in `{ connectionId: 'abc' }`.
    if (prop.key.type === 'Identifier') {
        return prop.key.name === 'connectionId';
    }
    // Literal key in `{ 'connectionId': 'abc' }`.
    return prop.key.type === 'Literal' && prop.key.value === 'connectionId';
}

/**
 * Resolves a supported static connectionId expression to a string.
 */
function resolveConnectionIdValue(
    node: Expression,
    bindings: SameModuleBindings,
    filePath: string,
    resolutionStack: string[] = [],
): string {
    if (node.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
    }
    if (node.type === 'TemplateLiteral') {
        return resolveStaticTemplateLiteral(node, filePath);
    }
    if (node.type === 'Identifier') {
        return resolveConnectionIdIdentifier(node.name, bindings, filePath, resolutionStack);
    }
    if (node.type === 'MemberExpression') {
        return resolveConnectionIdMember(node, bindings, filePath, resolutionStack);
    }
    fail(
        `Unsupported connectionId expression in ${filePath}: expected a static string literal, static template literal, same-file const identifier, or same-file const object member; got ${node.type}.`,
    );
}

/**
 * Resolves a template literal that has no dynamic expressions.
 */
function resolveStaticTemplateLiteral(node: TemplateLiteral, filePath: string): string {
    if (node.expressions.length > 0) {
        fail(
            `Unsupported connectionId expression in ${filePath}: template literals with interpolations cannot be statically analyzed.`,
        );
    }

    const quasi = node.quasis[0];
    return quasi.value.cooked ?? quasi.value.raw;
}

/**
 * Resolves a connectionId identifier through same-file top-level const bindings.
 */
function resolveConnectionIdIdentifier(
    name: string,
    bindings: SameModuleBindings,
    filePath: string,
    resolutionStack: string[],
): string {
    const mutableKind = bindings.mutables.get(name);
    if (mutableKind) {
        fail(
            `Unsupported connectionId expression in ${filePath}: '${name}' is declared with '${mutableKind}' and may be reassigned; only top-level const bindings are supported.`,
        );
    }
    if (bindings.importedIdentifiers.has(name) || bindings.importedNamespaces.has(name)) {
        fail(
            `Unsupported connectionId expression in ${filePath}: imported identifier '${name}' cannot be statically analyzed in this PR.`,
        );
    }

    const init = bindings.consts.get(name);
    if (!init) {
        fail(
            `Unsupported connectionId expression in ${filePath}: identifier '${name}' is not a top-level same-file const binding.`,
        );
    }
    if (resolutionStack.includes(name)) {
        fail(
            `Unsupported connectionId expression in ${filePath}: cyclic const connectionId reference '${[
                ...resolutionStack,
                name,
            ].join(' -> ')}'.`,
        );
    }
    if (resolutionStack.length >= MAX_CONST_RESOLUTION_DEPTH) {
        fail(
            `Unsupported connectionId expression in ${filePath}: const connectionId reference chain is too deep.`,
        );
    }

    return resolveConnectionIdValue(init, bindings, filePath, [...resolutionStack, name]);
}

/**
 * Resolves a connectionId member expression through same-file const object members.
 */
function resolveConnectionIdMember(
    node: MemberExpression,
    bindings: SameModuleBindings,
    filePath: string,
    resolutionStack: string[],
): string {
    if (node.computed) {
        fail(
            `Unsupported connectionId expression in ${filePath}: computed member expressions cannot be statically analyzed.`,
        );
    }
    if (node.object.type !== 'Identifier') {
        fail(
            `Unsupported connectionId expression in ${filePath}: nested or non-static member expressions cannot be statically analyzed.`,
        );
    }

    const objectName = node.object.name;
    const propertyName = readStaticPropertyName(node.property);
    if (!propertyName) {
        fail(
            `Unsupported connectionId expression in ${filePath}: member property must be a static identifier.`,
        );
    }

    const mutableKind = bindings.mutables.get(objectName);
    if (mutableKind) {
        fail(
            `Unsupported connectionId expression in ${filePath}: object '${objectName}' is declared with '${mutableKind}' and may be reassigned; only top-level const object literals are supported.`,
        );
    }
    if (
        bindings.importedIdentifiers.has(objectName) ||
        bindings.importedNamespaces.has(objectName)
    ) {
        fail(
            `Unsupported connectionId expression in ${filePath}: imported object '${objectName}' cannot be statically analyzed in this PR.`,
        );
    }

    const objectInit = bindings.consts.get(objectName);
    if (!objectInit) {
        fail(
            `Unsupported connectionId expression in ${filePath}: object '${objectName}' is not a top-level same-file const binding.`,
        );
    }
    if (objectInit.type !== 'ObjectExpression') {
        fail(
            `Unsupported connectionId expression in ${filePath}: object '${objectName}' must be initialized to an object literal.`,
        );
    }

    return resolveObjectMemberValue(objectInit, propertyName, bindings, filePath, resolutionStack);
}

/**
 * Resolves one static property from a const object expression.
 */
function resolveObjectMemberValue(
    objectExpression: ObjectExpression,
    propertyName: string,
    bindings: SameModuleBindings,
    filePath: string,
    resolutionStack: string[],
): string {
    let value: Expression | undefined;

    for (const prop of objectExpression.properties) {
        if (prop.type === 'SpreadElement') {
            fail(
                `Unsupported connectionId expression in ${filePath}: object spreads can hide connectionId object members.`,
            );
        }
        if (prop.type !== 'Property') {
            continue;
        }
        if (prop.computed) {
            fail(
                `Unsupported connectionId expression in ${filePath}: computed object properties can hide connectionId object members.`,
            );
        }

        const key = readStaticPropertyName(prop.key);
        if (key !== propertyName) {
            continue;
        }
        if (value) {
            fail(
                `Unsupported connectionId expression in ${filePath}: object member '${propertyName}' is defined multiple times.`,
            );
        }
        value = prop.value as Expression;
    }

    if (!value) {
        fail(
            `Unsupported connectionId expression in ${filePath}: object has no static '${propertyName}' property.`,
        );
    }

    return resolveConnectionIdValue(value, bindings, filePath, resolutionStack);
}

/**
 * Reads a property name when the ESTree property key is statically known.
 */
function readStaticPropertyName(node: Node): string | undefined {
    if (node.type === 'Identifier') {
        return node.name;
    }
    if (node.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
    }
    return undefined;
}

/**
 * Reports whether a call expression callee resolves directly to an action-catalog import.
 */
function isActionCatalogCallee(
    callee: Expression | Super,
    imports: ActionCatalogImports,
    shadowedBindings: Set<string>,
): boolean {
    // Named/default import call: `request({ connectionId: 'abc' })`.
    if (callee.type === 'Identifier') {
        return imports.functions.has(callee.name) && !shadowedBindings.has(callee.name);
    }
    // Namespace import call: `http.request({ connectionId: 'abc' })`.
    if (callee.type !== 'MemberExpression') {
        return false;
    }
    return isNamespaceMember(callee, imports.namespaces, shadowedBindings);
}

/**
 * Fails on action-catalog call shapes this PR intentionally cannot analyze.
 */
function failIfUnsupportedActionCatalogCallee(
    callee: Expression | Super,
    imports: ActionCatalogImports,
    shadowedBindings: Set<string>,
    filePath: string,
): void {
    // Unsupported alias call: `const action = request; action(...)`.
    if (
        callee.type === 'Identifier' &&
        imports.unsupportedAliases.has(callee.name) &&
        !shadowedBindings.has(callee.name)
    ) {
        fail(
            `Unsupported action-catalog call in ${filePath}: action-catalog call aliases cannot be statically analyzed for connectionId.`,
        );
    }
    // Unsupported computed namespace call: `http['request'](...)`.
    if (
        callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        imports.namespaces.has(callee.object.name) &&
        !shadowedBindings.has(callee.object.name) &&
        callee.computed
    ) {
        fail(
            `Unsupported action-catalog call in ${filePath}: computed namespace member calls cannot be statically analyzed for connectionId.`,
        );
    }
}

/**
 * Reports whether a member expression is a direct access on an action-catalog namespace import.
 */
function isNamespaceMember(
    member: MemberExpression,
    namespaces: Set<string>,
    shadowedBindings: Set<string>,
): boolean {
    return (
        // `http.request(...)` where `http` came from `import * as http`.
        member.object.type === 'Identifier' &&
        namespaces.has(member.object.name) &&
        !shadowedBindings.has(member.object.name) &&
        // The member must be statically named, unlike `http[actionName](...)`.
        member.property.type === 'Identifier' &&
        !member.computed
    );
}

/**
 * Recursively reports whether a callee member chain includes optional access.
 */
function containsOptionalMember(node: Node): boolean {
    // Finds optional access in callees like `http?.request(...)`.
    if (node.type === 'MemberExpression') {
        return isOptionalNode(node) || containsOptionalMember(node.object);
    }
    return false;
}

/**
 * Reads the optional flag that ESTree parsers attach to optional call/member nodes.
 */
function isOptionalNode(node: Node): boolean {
    return (node as Node & { optional?: boolean }).optional === true;
}

/**
 * Walks an ESTree subtree while tracking local bindings that shadow action-catalog imports.
 *
 * For example, given:
 *
 * ```ts
 * import { request } from '@datadog/action-catalog/http/http';
 * request({ connectionId: 'real-action' });
 * export function run(request) {
 *     request({ connectionId: 'local-param' });
 * }
 * ```
 *
 * The visitor sees the top-level `request(...)` with an empty shadow set, so it can be treated as
 * the imported action. Inside `run`, the function parameter shadows the import, so the visitor sees
 * `shadowedBindings.has('request') === true` and ignores that local call.
 */
function walkWithScope(
    node: Node,
    imports: ActionCatalogImports,
    visit: (node: Node, shadowedBindings: Set<string>) => void,
    shadowedBindings = new Set<string>(),
): void {
    visit(node, shadowedBindings);

    // Module body for source like `import ...; export function run() {}`.
    if (node.type === 'Program') {
        for (const statement of node.body) {
            walkWithScope(statement, imports, visit, shadowedBindings);
        }
        return;
    }
    // Block scope for `{ const request = localClient; request(...) }`.
    if (node.type === 'BlockStatement') {
        const blockScope = new Set(shadowedBindings);
        collectShadowingDeclarations(node.body, imports, blockScope);
        for (const statement of node.body) {
            walkWithScope(statement, imports, visit, blockScope);
        }
        return;
    }
    // Function parameters can shadow action imports:
    // `function run(request) { request({ connectionId: 'local' }) }`.
    if (
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression'
    ) {
        const functionScope = new Set(shadowedBindings);
        for (const param of node.params) {
            addShadowedPatternBindings(param, imports, functionScope);
        }
        walkWithScope(node.body, imports, visit, functionScope);
        return;
    }
    // Catch parameters can shadow imports:
    // `catch (request) { request({ connectionId: 'local' }) }`.
    if (node.type === 'CatchClause') {
        const catchScope = new Set(shadowedBindings);
        if (node.param) {
            addShadowedPatternBindings(node.param, imports, catchScope);
        }
        walkWithScope(node.body, imports, visit, catchScope);
        return;
    }

    for (const value of Object.values(node as unknown as Record<string, unknown>)) {
        if (Array.isArray(value)) {
            for (const child of value) {
                if (isNode(child)) {
                    walkWithScope(child, imports, visit, shadowedBindings);
                }
            }
        } else if (isNode(value)) {
            walkWithScope(value, imports, visit, shadowedBindings);
        }
    }
}

/**
 * Adds block-scoped declarations that shadow tracked action-catalog names.
 */
function collectShadowingDeclarations(
    statements: Statement[],
    imports: ActionCatalogImports,
    shadowedBindings: Set<string>,
): void {
    for (const statement of statements) {
        if (statement.type === 'VariableDeclaration') {
            for (const declaration of statement.declarations) {
                // Preserve action aliases like `const action = request` as
                // unsupported aliases instead of treating them as local shadowing.
                if (isActionCatalogAliasDeclaration(declaration, imports, shadowedBindings)) {
                    continue;
                }
                addShadowedPatternBindings(declaration.id, imports, shadowedBindings);
            }
            // `function request() {}` shadows an imported `request` inside the block.
        } else if (statement.type === 'FunctionDeclaration' && statement.id) {
            addShadowedBinding(statement.id.name, imports, shadowedBindings);
            // `class http {}` shadows an imported namespace named `http`.
        } else if (statement.type === 'ClassDeclaration' && statement.id) {
            addShadowedBinding(statement.id.name, imports, shadowedBindings);
        }
    }
}

/**
 * Reports whether a variable declarator creates an unsupported alias of an action-catalog call.
 */
function isActionCatalogAliasDeclaration(
    declaration: VariableDeclarator,
    imports: ActionCatalogImports,
    shadowedBindings: Set<string>,
): boolean {
    // `const action = request`
    if (
        declaration.id.type === 'Identifier' &&
        declaration.init?.type === 'Identifier' &&
        imports.functions.has(declaration.init.name) &&
        !shadowedBindings.has(declaration.init.name)
    ) {
        return true;
    }
    // `const action = http.request`
    if (
        declaration.id.type === 'Identifier' &&
        declaration.init?.type === 'MemberExpression' &&
        isNamespaceMember(declaration.init, imports.namespaces, shadowedBindings)
    ) {
        return true;
    }
    // `const { request: action } = http`
    return (
        declaration.id.type === 'ObjectPattern' &&
        declaration.init?.type === 'Identifier' &&
        imports.namespaces.has(declaration.init.name) &&
        !shadowedBindings.has(declaration.init.name)
    );
}

/**
 * Adds every identifier introduced by a binding pattern to the current shadowing set.
 */
function addShadowedPatternBindings(
    pattern: Node,
    imports: ActionCatalogImports,
    shadowedBindings: Set<string>,
): void {
    for (const name of getPatternBindingNames(pattern)) {
        addShadowedBinding(name, imports, shadowedBindings);
    }
}

/**
 * Adds a local binding name when it shadows an action-catalog import or alias.
 */
function addShadowedBinding(
    name: string,
    imports: ActionCatalogImports,
    shadowedBindings: Set<string>,
): void {
    if (
        imports.functions.has(name) ||
        imports.namespaces.has(name) ||
        imports.unsupportedAliases.has(name)
    ) {
        shadowedBindings.add(name);
    }
}

/**
 * Returns the identifier names declared by an ESTree binding pattern.
 */
function getPatternBindingNames(pattern: Node): string[] {
    // `request` in `function run(request) {}` or `const request = client`.
    if (pattern.type === 'Identifier') {
        return [pattern.name];
    }
    // `rest` in `const { ...rest } = value`.
    if (pattern.type === 'RestElement') {
        return getPatternBindingNames(pattern.argument);
    }
    // `request` in `function run(request = client) {}`.
    if (pattern.type === 'AssignmentPattern') {
        return getPatternBindingNames(pattern.left);
    }
    // `request` in `const [request] = clients`.
    if (pattern.type === 'ArrayPattern') {
        return pattern.elements.flatMap((element) =>
            element ? getPatternBindingNames(element) : [],
        );
    }
    // `request` in `const { client: request } = clients`.
    if (pattern.type === 'ObjectPattern') {
        return pattern.properties.flatMap((prop) => {
            if (prop.type === 'RestElement') {
                return getPatternBindingNames(prop.argument);
            }
            return getPatternBindingNames(prop.value as Node);
        });
    }
    return [];
}

/**
 * Reports whether an unknown value looks like an ESTree node.
 */
function isNode(value: unknown): value is Node {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { type?: unknown }).type === 'string'
    );
}

/**
 * Throws a consistently prefixed extraction error.
 */
function fail(message: string): never {
    throw new ConnectionIdExtractionError(`[connectionId manifest] ${message}`);
}
