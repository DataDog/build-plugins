// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as eslintScope from 'eslint-scope';
import type {
    AssignmentExpression,
    BaseNode,
    Identifier,
    MemberExpression,
    Node,
    ObjectExpression,
    Pattern,
    Program,
    Property,
    SimpleCallExpression,
    VariableDeclarator,
} from 'estree';

import { isProgramNode } from './type-guards';
import { walkAst } from './walk-ast';

const ACTION_CATALOG_PACKAGE = '@datadog/action-catalog';
const CONNECTION_ID_PROPERTY = 'connectionId';

interface ActionCatalogImports {
    functions: Set<string>;
    namespaces: Set<string>;
    unsupportedAliases: Set<eslintScope.Variable>;
}

// Do not trust names alone when deciding whether `request(...)` is an
// action-catalog call. A local parameter or variable can reuse the same name:
//
//   import { request } from '@datadog/action-catalog/http/http';
//   request({ connectionId: 'real' });
//
//   function run(request) {
//     request({ connectionId: 'local' });
//   }
//
// Both calls use the text `request`, but only the first one refers to the
// imported action-catalog function. eslint-scope tells us which declaration each
// identifier refers to, and ScopeAnalysis keeps the lookup tables we need while
// walking the file.
interface ScopeAnalysis {
    // The full scope model from eslint-scope, used when we need declared
    // variables for aliases like `const action = request`.
    scopeManager: eslintScope.ScopeManager;

    // Maps each identifier node to the declaration eslint-scope resolved it to.
    references: Map<Identifier, eslintScope.Reference>;

    // The actual import variables for action-catalog functions and namespaces.
    // Call sites must resolve to one of these variables to count.
    actionFunctions: Set<eslintScope.Variable>;
    actionNamespaces: Set<eslintScope.Variable>;
}

type NodeWithOptionalImportKind = BaseNode & { importKind?: string };
type NodeWithRange = Node & { start?: number; end?: number; range?: [number, number] };

export function extractConnectionIds(ast: BaseNode, filePath: string): string[] {
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

    const scopeAnalysis = analyzeScopes(ast, imports);
    collectUnsupportedActionCatalogAliases(ast, imports, scopeAnalysis);

    const connectionIds = new Set<string>();
    walkAst(ast, scopeAnalysis, {
        CallExpression(node, { state }) {
            const actionCall = classifyActionCatalogCall(node, imports, state, filePath);
            if (!actionCall) {
                return;
            }

            extractConnectionIdFromActionCall(node, filePath, connectionIds);
        },
    });

    return [...connectionIds].sort();
}

function collectActionCatalogImports(ast: Program): ActionCatalogImports {
    const functions = new Set<string>();
    const namespaces = new Set<string>();
    const unsupportedAliases = new Set<eslintScope.Variable>();

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
    scopeAnalysis: ScopeAnalysis,
    filePath: string,
): boolean {
    const callee = node.callee;

    if (callee.type === 'Identifier') {
        if (resolvesTo(callee, imports.unsupportedAliases, scopeAnalysis)) {
            throw unsupportedActionCatalogCall(filePath, 'action-catalog call aliases');
        }
        if (resolvesTo(callee, scopeAnalysis.actionFunctions, scopeAnalysis)) {
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

    if (!isNamespaceMember(callee, scopeAnalysis)) {
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

function collectUnsupportedActionCatalogAliases(
    ast: Program,
    imports: ActionCatalogImports,
    scopeAnalysis: ScopeAnalysis,
): void {
    walkAst(ast, scopeAnalysis, {
        VariableDeclarator(node, { state }) {
            for (const aliasVariable of getActionCatalogAliasVariables(node, state)) {
                imports.unsupportedAliases.add(aliasVariable);
            }
        },
        AssignmentExpression(node, { state }) {
            for (const aliasVariable of getAssignedActionCatalogAliasVariables(node, state)) {
                imports.unsupportedAliases.add(aliasVariable);
            }
        },
    });
}

/**
 * Finds variables declared as aliases of an action-catalog function.
 *
 * Examples this catches:
 * - `const action = request`
 * - `const action = http.request`
 * - `const { request: action } = http`
 *
 * We do not try to follow these aliases. Instead, we mark them as unsupported
 * so a later `action(...)` call fails closed instead of silently missing a
 * `connectionId`.
 */
function getActionCatalogAliasVariables(
    node: VariableDeclarator,
    scopeAnalysis: ScopeAnalysis,
): eslintScope.Variable[] {
    // `const action = request`
    if (
        node.id.type === 'Identifier' &&
        node.init?.type === 'Identifier' &&
        resolvesTo(node.init, scopeAnalysis.actionFunctions, scopeAnalysis)
    ) {
        return getDeclaredVariables(node, scopeAnalysis, [node.id.name]);
    }

    // `const action = http.request`
    if (
        node.id.type === 'Identifier' &&
        node.init?.type === 'MemberExpression' &&
        isNamespaceMember(node.init, scopeAnalysis)
    ) {
        return getDeclaredVariables(node, scopeAnalysis, [node.id.name]);
    }

    // Ignore declarations that are not destructuring an action-catalog namespace,
    // then handle `const { request: action } = http` below.
    if (
        node.id.type !== 'ObjectPattern' ||
        node.init?.type !== 'Identifier' ||
        !resolvesTo(node.init, scopeAnalysis.actionNamespaces, scopeAnalysis)
    ) {
        return [];
    }

    // In a declaration, eslint-scope can give us declared variables from the
    // whole `const { request: action } = http` node. We only need identifier
    // names to pick the alias variables out of that declaration result.
    const aliasNames = node.id.properties
        .flatMap((property) => {
            if (property.type === 'RestElement' || property.computed) {
                return [];
            }
            return collectPatternIdentifiers(property.value);
        })
        .map((identifier) => identifier.name);
    return getDeclaredVariables(node, scopeAnalysis, aliasNames);
}

/**
 * Finds existing variables that are assigned an action-catalog function after
 * they have already been declared.
 *
 * Examples this catches:
 * - `let action; action = request`
 * - `let action; action = http.request`
 * - `let action; ({ request: action } = http)`
 *
 * These are the assignment-expression versions of the declarations handled by
 * `getActionCatalogAliasVariables`.
 */
function getAssignedActionCatalogAliasVariables(
    node: AssignmentExpression,
    scopeAnalysis: ScopeAnalysis,
): eslintScope.Variable[] {
    // `let action; action = request`
    if (
        node.left.type === 'Identifier' &&
        node.right.type === 'Identifier' &&
        resolvesTo(node.right, scopeAnalysis.actionFunctions, scopeAnalysis)
    ) {
        return getResolvedVariables([node.left], scopeAnalysis);
    }

    // `let action; action = http.request`
    if (
        node.left.type === 'Identifier' &&
        node.right.type === 'MemberExpression' &&
        isNamespaceMember(node.right, scopeAnalysis)
    ) {
        return getResolvedVariables([node.left], scopeAnalysis);
    }

    // Ignore assignments that are not destructuring an action-catalog namespace,
    // then handle `let action; ({ request: action } = http)` below.
    if (
        node.left.type !== 'ObjectPattern' ||
        node.right.type !== 'Identifier' ||
        !resolvesTo(node.right, scopeAnalysis.actionNamespaces, scopeAnalysis)
    ) {
        return [];
    }

    // In an assignment, the variables already exist. Keep the actual identifier
    // nodes so eslint-scope can resolve each one back to the existing variable.
    const aliasIdentifiers = node.left.properties.flatMap((property) => {
        if (property.type === 'RestElement' || property.computed) {
            return [];
        }
        return collectPatternIdentifiers(property.value);
    });
    return getResolvedVariables(aliasIdentifiers, scopeAnalysis);
}

function getImportedNames(imports: ActionCatalogImports): Set<string> {
    return new Set([...imports.functions, ...imports.namespaces]);
}

/**
 * Returns true when a property access starts from an imported action-catalog
 * namespace.
 *
 * For `http.request(...)`, this checks that `http` is the namespace imported by
 * `import * as http from '@datadog/action-catalog/...'`, not a local variable
 * that happens to be named `http`.
 */
function isNamespaceMember(node: MemberExpression, scopeAnalysis: ScopeAnalysis): boolean {
    const root = getMemberExpressionRoot(node);
    return !!root && resolvesTo(root, scopeAnalysis.actionNamespaces, scopeAnalysis);
}

/**
 * Returns the left-most identifier in a property access chain.
 *
 * Examples:
 * - `http.request` -> `http`
 * - `catalog.http.request` -> `catalog`
 *
 * The root name is what scope analysis can resolve back to an import or local
 * declaration.
 */
function getMemberExpressionRoot(node: MemberExpression): Identifier | undefined {
    if (node.object.type === 'Identifier') {
        return node.object;
    }
    if (node.object.type === 'MemberExpression') {
        return getMemberExpressionRoot(node.object);
    }
    return undefined;
}

/**
 * Detects namespace call shapes we intentionally do not support.
 *
 * We only support direct, non-optional property access like `http.request(...)`.
 * Computed or optional forms such as `http['request'](...)` and
 * `http?.request(...)` could hide what action is called, so they fail closed.
 */
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

function analyzeScopes(ast: Program, imports: ActionCatalogImports): ScopeAnalysis {
    ensureRanges(ast);
    const scopeManager = eslintScope.analyze(ast, {
        ecmaVersion: 2022,
        ignoreEval: true,
        sourceType: 'module',
    });

    const references = new Map<Identifier, eslintScope.Reference>();
    const actionFunctions = new Set<eslintScope.Variable>();
    const actionNamespaces = new Set<eslintScope.Variable>();

    // Cache every identifier reference so call classification can ask "what
    // variable does this exact node resolve to?" without re-walking scopes.
    for (const scope of scopeManager.scopes) {
        for (const reference of scope.references) {
            references.set(reference.identifier, reference);
        }

        // Save the actual import declarations that came from action-catalog.
        // Later, when we see `request(...)`, we check whether that `request`
        // points back to one of these declarations instead of to a local
        // parameter or variable with the same name.
        for (const variable of scope.variables) {
            if (!isImportVariable(variable)) {
                continue;
            }
            if (imports.functions.has(variable.name)) {
                actionFunctions.add(variable);
            }
            if (imports.namespaces.has(variable.name)) {
                actionNamespaces.add(variable);
            }
        }
    }

    return { scopeManager, references, actionFunctions, actionNamespaces };
}

function isImportVariable(variable: eslintScope.Variable): boolean {
    return variable.defs.some((definition) => definition.type === 'ImportBinding');
}

/**
 * Checks whether an identifier points to one of the exact variables we care
 * about.
 *
 * This is the shadowing-safe comparison. For example, a local function
 * parameter named `request` has the same text as an imported `request`, but
 * eslint-scope resolves it to a different variable.
 *
 * @param identifier - The exact identifier node from the AST, such as the
 * `request` in `request(...)`.
 * @param variables - The set of allowed target variables, such as the imported
 * action-catalog function declarations.
 * @param scopeAnalysis - The precomputed eslint-scope lookup tables that map
 * identifier nodes back to the variables they reference.
 */
function resolvesTo(
    identifier: Identifier,
    variables: ReadonlySet<eslintScope.Variable>,
    scopeAnalysis: ScopeAnalysis,
): boolean {
    // eslint-scope has already resolved this Identifier to the declaration it
    // refers to. Comparing Variable identity is what makes shadowing safe.
    const reference = scopeAnalysis.references.get(identifier);
    return !!reference?.resolved && variables.has(reference.resolved);
}

/**
 * Converts identifier nodes into the variables they refer to.
 *
 * This is used for assignment aliases because the variable already exists:
 * `action = request` does not declare `action`, it only assigns to it. We ask
 * eslint-scope which existing variable that `action` identifier points to.
 */
function getResolvedVariables(
    identifiers: Identifier[],
    scopeAnalysis: ScopeAnalysis,
): eslintScope.Variable[] {
    return identifiers.flatMap((identifier) => {
        const variable = scopeAnalysis.references.get(identifier)?.resolved;
        return variable ? [variable] : [];
    });
}

/**
 * Returns variables created by a declaration node, limited to the names we
 * extracted from the declaration pattern.
 *
 * This is used for alias declarations like `const action = request`, where the
 * declaration itself creates the `action` variable we need to remember.
 */
function getDeclaredVariables(
    node: Node,
    scopeAnalysis: ScopeAnalysis,
    names: string[],
): eslintScope.Variable[] {
    // Alias declarations are tracked as Variables too, so later `action(...)`
    // calls can fail closed only when they resolve to the alias we identified.
    const wantedNames = new Set(names);
    return scopeAnalysis.scopeManager
        .getDeclaredVariables(node)
        .filter((variable) => wantedNames.has(variable.name));
}

/**
 * Pulls identifier nodes out of a declaration or assignment pattern.
 *
 * Patterns are the left side of declarations or assignments, such as:
 * - `const action = ...`
 * - `const { request: action } = ...`
 * - `({ request: action } = ...)`
 *
 * Declarations use the identifier names to filter variables created by the
 * declaration. Assignments use the identifier nodes directly, because
 * eslint-scope resolves those nodes to existing variables.
 */
function collectPatternIdentifiers(pattern: Pattern): Identifier[] {
    switch (pattern.type) {
        case 'Identifier':
            return [pattern];
        case 'ObjectPattern':
            return pattern.properties.flatMap((property) => {
                if (property.type === 'RestElement') {
                    return collectPatternIdentifiers(property.argument);
                }
                return collectPatternIdentifiers(property.value);
            });
        case 'ArrayPattern':
            return pattern.elements.flatMap((element) =>
                element ? collectPatternIdentifiers(element) : [],
            );
        case 'RestElement':
            return collectPatternIdentifiers(pattern.argument);
        case 'AssignmentPattern':
            return collectPatternIdentifiers(pattern.left);
        case 'MemberExpression':
            return [];
    }
}

function ensureRanges(node: Node): void {
    walkAst(node, null, {
        _(child) {
            const nodeWithRange = child as NodeWithRange;
            if (
                !nodeWithRange.range &&
                typeof nodeWithRange.start === 'number' &&
                typeof nodeWithRange.end === 'number'
            ) {
                nodeWithRange.range = [nodeWithRange.start, nodeWithRange.end];
            }
        },
    });
}
