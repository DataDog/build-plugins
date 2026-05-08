// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type * as eslintScope from 'eslint-scope';
import type {
    Expression,
    Identifier,
    Literal,
    ObjectExpression,
    Program,
    Property,
    SimpleCallExpression,
    TemplateLiteral,
    VariableDeclaration,
} from 'estree';

import {
    isImportVariable,
    resolveIdentifier,
    type ScopeAnalysis,
} from './action-catalog-call-sites';

const CONNECTION_ID_PROPERTY = 'connectionId';

type VariableKind = VariableDeclaration['kind'];
type ConnectionIdProperty = Property & { value: Expression };

/**
 * Describes what kind of same-file variable a connectionId expression points to.
 *
 * We record declarations before resolving values so later reads can be checked by
 * declaration identity, not by name. For example, the `ID` in
 * `request({ connectionId: ID })` must point to the same variable created by
 * `const ID = 'abc'`, not a shadowed function parameter also named `ID`.
 */
type StaticBinding =
    /**
     * A top-level `const` declaration whose initializer can be followed during
     * connection ID resolution.
     *
     * Example:
     *
     * ```ts
     * const HTTP_CONNECTION_ID = 'conn-http';
     * request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
     * ```
     */
    | {
          kind: 'const';
          init: Expression | null;
      }
    /**
     * A top-level `let` or `var` declaration. The binding is known, but the
     * value can change before the action call executes, so reads fail closed.
     *
     * Example:
     *
     * ```ts
     * let HTTP_CONNECTION_ID = 'conn-http';
     * HTTP_CONNECTION_ID = getConnectionId();
     * request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
     * ```
     */
    | {
          kind: 'mutable';
          declarationKind: Exclude<VariableKind, 'const'>;
      }
    /**
     * A declaration that creates variables through a binding pattern. Patterns
     * can hide aliasing behavior, so reads from these bindings fail closed.
     *
     * Example:
     *
     * ```ts
     * const { HTTP: HTTP_CONNECTION_ID } = CONNECTIONS;
     * request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
     * ```
     */
    | {
          kind: 'unsupported-pattern';
      };

/**
 * Same-file declarations that may be used while resolving connection IDs.
 *
 * The map key is an `eslintScope.Variable`. In plain terms, that is
 * eslint-scope's object for one specific declaration in the source file. For
 * example, in `const HTTP = 'abc'`, eslint-scope creates one `Variable` for
 * that top-level `HTTP` declaration. If a function later declares another
 * `HTTP`, eslint-scope creates a different `Variable` for that inner
 * declaration. Using the `Variable` object as the key is what makes this
 * shadowing-safe; we are not matching by the text name `HTTP` alone.
 *
 * The map value is a `StaticBinding`, which is our smaller summary of whether
 * that declaration is safe to use as a connection ID source:
 *
 * - `const`: keep the initializer expression, such as the `'abc'` in
 *   `const HTTP = 'abc'`, so the resolver can read it later.
 * - `mutable`: remember that the declaration came from `let` or `var`, so
 *   `connectionId: HTTP` fails closed instead of trusting a value that can
 *   change.
 * - `unsupported-pattern`: remember that the declaration came from a binding
 *   pattern such as `const { HTTP } = CONNECTIONS`, which this PR intentionally
 *   does not resolve.
 */
export interface SameModuleConnectionIdBindings {
    byVariable: Map<eslintScope.Variable, StaticBinding>;
}

/**
 * Shared state for one `connectionId` value resolution.
 *
 * `seen` tracks the const declarations currently being followed. It prevents
 * infinite recursion for cycles such as `const A = B; const B = A;`.
 */
interface ConnectionIdResolutionContext {
    bindings: SameModuleConnectionIdBindings;
    filePath: string;
    scopeAnalysis: ScopeAnalysis;
    seen: Set<eslintScope.Variable>;
}

/**
 * Collects top-level variable declarations that same-module connection IDs may
 * reference.
 *
 * Supported declarations are deliberately narrow. A top-level `const` keeps its
 * initializer so `connectionId: HTTP_CONNECTION_ID` can resolve through
 * `const HTTP_CONNECTION_ID = 'abc'`. Top-level `let` and `var` declarations are
 * recorded as mutable so they fail closed if used. Destructured declarations are
 * recorded as unsupported because `const { HTTP } = CONNECTIONS` adds more
 * aliasing behavior than this PR intends to support.
 */
export function collectSameModuleConnectionIdBindings(
    ast: Program,
    scopeAnalysis: ScopeAnalysis,
): SameModuleConnectionIdBindings {
    const byVariable = new Map<eslintScope.Variable, StaticBinding>();

    for (const node of ast.body) {
        // Top-level declarations such as:
        //   const HTTP_CONNECTION_ID = 'abc';
        if (node.type === 'VariableDeclaration') {
            collectVariableDeclarationBindings(node, scopeAnalysis, byVariable);
            continue;
        }

        // Exported top-level declarations are still same-module values:
        //   export const HTTP_CONNECTION_ID = 'abc';
        if (
            node.type === 'ExportNamedDeclaration' &&
            node.declaration?.type === 'VariableDeclaration'
        ) {
            collectVariableDeclarationBindings(node.declaration, scopeAnalysis, byVariable);
        }
    }

    return { byVariable };
}

/**
 * Reads the `connectionId` value from a known action-catalog call.
 *
 * At this point another module has already proven the call is action-catalog,
 * for example `request(...)` or `http.request(...)`. This function only looks at
 * the first argument object:
 *
 * ```ts
 * request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
 * ```
 *
 * If the call has no `connectionId`, it returns `undefined`. If it has a
 * `connectionId` that cannot be statically resolved, it throws so the manifest
 * does not silently miss an allowlist entry.
 */
export function extractConnectionIdFromActionCall(
    node: SimpleCallExpression,
    bindings: SameModuleConnectionIdBindings,
    scopeAnalysis: ScopeAnalysis,
    filePath: string,
): string | undefined {
    const [firstArg] = node.arguments;
    if (!firstArg || firstArg.type !== 'ObjectExpression') {
        throw unsupportedActionCatalogCall(filePath, 'non-object action-catalog call arguments');
    }

    const connectionIdProperty = findConnectionIdProperty(firstArg, filePath);
    if (!connectionIdProperty) {
        return undefined;
    }

    return resolveConnectionIdValue(connectionIdProperty.value, {
        bindings,
        filePath,
        scopeAnalysis,
        seen: new Set(),
    });
}

/**
 * Records variables created by one top-level declaration statement.
 *
 * For `const HTTP = 'abc'`, eslint-scope tells us which variable object belongs
 * to the `HTTP` declaration. We store that object with the initializer expression
 * `'abc'`. For `let HTTP = 'abc'`, we still store the variable, but mark it
 * mutable so reads fail closed later.
 */
function collectVariableDeclarationBindings(
    declaration: VariableDeclaration,
    scopeAnalysis: ScopeAnalysis,
    byVariable: Map<eslintScope.Variable, StaticBinding>,
): void {
    for (const declarator of declaration.declarations) {
        const variables = scopeAnalysis.scopeManager.getDeclaredVariables(declarator);

        // Destructuring creates variables, but we do not resolve it in this PR:
        //   const { HTTP } = CONNECTIONS;
        if (declarator.id.type !== 'Identifier') {
            for (const variable of variables) {
                byVariable.set(variable, { kind: 'unsupported-pattern' });
            }
            continue;
        }

        // For a simple declaration like `const HTTP = 'abc'`, eslint-scope
        // should return the single Variable created for `HTTP`. The guard is
        // defensive in case a parser/scope edge case gives us no declaration.
        const [variable] = variables;
        if (!variable) {
            continue;
        }

        // Immutable top-level values can be followed later:
        //   const HTTP_CONNECTION_ID = 'abc';
        if (declaration.kind === 'const') {
            byVariable.set(variable, { kind: 'const', init: declarator.init ?? null });
        } else {
            // Mutable values fail closed because the initializer may not be the
            // value used at runtime:
            //   let HTTP_CONNECTION_ID = 'abc';
            //   HTTP_CONNECTION_ID = getConnectionId();
            byVariable.set(variable, {
                kind: 'mutable',
                declarationKind: declaration.kind,
            });
        }
    }
}

/**
 * Resolves one ESTree expression into the final connection ID string.
 *
 * This is the dispatcher for the shapes this PR supports:
 *
 * - `'abc'`
 * - `` `abc` ``
 * - `HTTP_CONNECTION_ID`
 *
 * Any other expression, such as `getId()` or `'a' + suffix`, fails closed.
 */
function resolveConnectionIdValue(
    node: Expression,
    context: ConnectionIdResolutionContext,
): string {
    switch (node.type) {
        case 'Literal':
            return resolveLiteral(node, context.filePath);
        case 'TemplateLiteral':
            return resolveTemplateLiteral(node, context.filePath);
        case 'Identifier':
            return resolveIdentifierValue(node, context);
        default:
            throw unsupportedConnectionId(context.filePath, `unsupported ${node.type} values`);
    }
}

/**
 * Resolves a string literal expression.
 *
 * Example: `request({ connectionId: 'abc' })`.
 */
function resolveLiteral(node: Literal, filePath: string): string {
    if (typeof node.value === 'string') {
        return node.value;
    }
    throw unsupportedConnectionId(filePath, `non-string Literal values`);
}

/**
 * Resolves a template literal only when it is fully static.
 *
 * Example supported value: `` connectionId: `abc` ``.
 * Example rejected value: `` connectionId: `${prefix}-abc` ``.
 */
function resolveTemplateLiteral(node: TemplateLiteral, filePath: string): string {
    if (node.expressions.length > 0) {
        throw unsupportedConnectionId(filePath, 'dynamic template literals');
    }

    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('');
}

/**
 * Resolves an identifier by following the variable it references.
 *
 * Example:
 *
 * ```ts
 * const HTTP_CONNECTION_ID = 'abc';
 * request({ connectionId: HTTP_CONNECTION_ID });
 * ```
 *
 * The identifier node is the `HTTP_CONNECTION_ID` inside the call. eslint-scope
 * tells us which declaration it points to. If that declaration is a supported
 * top-level `const`, we resolve the const initializer. Imported, mutable,
 * function-local, destructured, and unresolved identifiers all fail closed.
 */
function resolveIdentifierValue(
    identifier: Identifier,
    context: ConnectionIdResolutionContext,
): string {
    const variable = resolveIdentifier(identifier, context.scopeAnalysis);
    if (!variable) {
        // The identifier has no declaration eslint-scope can point to:
        //   request({ connectionId: HTTP_CONNECTION_ID });
        // with no `HTTP_CONNECTION_ID` declared in this file.
        throw unsupportedConnectionId(context.filePath, `unresolved identifier ${identifier.name}`);
    }

    if (isImportVariable(variable)) {
        // Imported values require following another module, which is deferred to
        // the module graph PR:
        //   import { HTTP_CONNECTION_ID } from './connections';
        throw unsupportedConnectionId(
            context.filePath,
            `imported connectionId binding ${identifier.name}`,
        );
    }

    const binding = context.bindings.byVariable.get(variable);
    if (!binding) {
        // The declaration exists, but it is not a top-level same-module binding:
        //   function run() {
        //     const HTTP_CONNECTION_ID = 'abc';
        //     request({ connectionId: HTTP_CONNECTION_ID });
        //   }
        throw unsupportedConnectionId(
            context.filePath,
            `non-top-level connectionId binding ${identifier.name}`,
        );
    }

    switch (binding.kind) {
        case 'mutable':
            // `let` and `var` can change after their initializer:
            //   let HTTP_CONNECTION_ID = 'abc';
            //   HTTP_CONNECTION_ID = getConnectionId();
            throw unsupportedConnectionId(
                context.filePath,
                `mutable ${binding.declarationKind} connectionId binding ${identifier.name}`,
            );
        case 'unsupported-pattern':
            // Destructured aliases are deliberately out of scope:
            //   const { HTTP: HTTP_CONNECTION_ID } = CONNECTIONS;
            throw unsupportedConnectionId(
                context.filePath,
                `destructured connectionId binding ${identifier.name}`,
            );
        case 'const':
            if (!binding.init) {
                // This is invalid JavaScript for plain `const`, but keep the
                // guard explicit for parser edge cases.
                throw unsupportedConnectionId(
                    context.filePath,
                    `uninitialized const connectionId binding ${identifier.name}`,
                );
            }
            if (context.seen.has(variable)) {
                // Const chains can reference each other; stop cycles before
                // recursion loops forever:
                //   const A = B;
                //   const B = A;
                throw unsupportedConnectionId(
                    context.filePath,
                    `cyclic connectionId binding ${identifier.name}`,
                );
            }

            // Follow supported const chains:
            //   const HTTP = 'abc';
            //   const ACTIVE_HTTP = HTTP;
            //   request({ connectionId: ACTIVE_HTTP });
            context.seen.add(variable);
            try {
                return resolveConnectionIdValue(binding.init, context);
            } finally {
                context.seen.delete(variable);
            }
    }
}

/**
 * Finds the `connectionId` property in an action-catalog call's options object.
 *
 * Example input object:
 *
 * ```ts
 * { connectionId: HTTP_CONNECTION_ID, inputs: {} }
 * ```
 *
 * This rejects spreads, computed keys, duplicate `connectionId` keys, and
 * accessor properties because those shapes can hide or change the actual value.
 */
function findConnectionIdProperty(
    objectExpression: ObjectExpression,
    filePath: string,
): ConnectionIdProperty | undefined {
    let connectionIdProperty: ConnectionIdProperty | undefined;
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
            if (!hasExpressionValue(property)) {
                throw unsupportedActionCatalogCall(
                    filePath,
                    'destructuring pattern in connectionId value',
                );
            }
            connectionIdProperty = property;
        }
    }
    return connectionIdProperty;
}

function hasExpressionValue(property: Property): property is ConnectionIdProperty {
    const { value } = property;
    return (
        value.type !== 'ObjectPattern' &&
        value.type !== 'ArrayPattern' &&
        value.type !== 'RestElement' &&
        value.type !== 'AssignmentPattern'
    );
}

function isConnectionIdKey(property: Property): boolean {
    return getStaticPropertyKey(property) === CONNECTION_ID_PROPERTY;
}

/**
 * Returns a property name when the key is statically visible in source.
 *
 * Supports object keys written as `HTTP: 'abc'` and `'HTTP': 'abc'`. Computed
 * keys such as `[key]: 'abc'` return `undefined`.
 */
function getStaticPropertyKey(property: Property): string | undefined {
    if (property.key.type === 'Identifier') {
        return property.key.name;
    }
    if (property.key.type === 'Literal' && typeof property.key.value === 'string') {
        return property.key.value;
    }
    return undefined;
}

function unsupportedActionCatalogCall(filePath: string, unsupported: string): Error {
    return new Error(
        `Unsupported action-catalog call in ${filePath}: ${unsupported} could hide a connectionId.`,
    );
}

function unsupportedConnectionId(filePath: string, unsupported: string): Error {
    return new Error(`Unsupported action-catalog connectionId in ${filePath}: ${unsupported}.`);
}
