// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type * as eslintScope from 'eslint-scope';
import type {
    Expression,
    Identifier,
    Literal,
    MemberExpression,
    ObjectExpression,
    Pattern,
    Program,
    Property,
    SimpleCallExpression,
    TemplateLiteral,
    UpdateExpression,
    VariableDeclaration,
} from 'estree';

import {
    isImportVariable,
    resolveIdentifier,
    type ScopeAnalysis,
} from './action-catalog-call-sites';
import { walkAst } from './walk-ast';

const CONNECTION_ID_PROPERTY = 'connectionId';

/**
 * Variable declaration kind recorded for fail-closed binding decisions.
 *
 * Example: `let HTTP_ID = 'conn'` records `let` so reads can report a mutable
 * binding instead of trusting the initializer.
 */
type VariableKind = VariableDeclaration['kind'];

/**
 * Object property whose value is guaranteed to be an expression.
 *
 * Example: `{ connectionId: HTTP_ID }` is accepted, while destructuring pattern
 * values are rejected before the property reaches value resolution.
 */
type ConnectionIdProperty = Property & { value: Expression };

/**
 * Describes what kind of same-file variable a connectionId expression points to.
 *
 * We record declarations before resolving values so later reads can be checked by
 * declaration identity, not by name. For example, the `ID` in
 * `request({ connectionId: ID })` must point to the same variable created by
 * `const ID = 'abc'`, not a shadowed function parameter also named `ID`.
 */
export type StaticBinding =
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
          /**
           * Marks a binding as a supported immutable declaration.
           *
           * Example: `const HTTP_ID = 'conn-http'`.
           */
          kind: 'const';
          /**
           * Initializer expression to resolve later.
           *
           * Example: the `'conn-http'` literal in `const HTTP_ID = 'conn-http'`.
           */
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
          /**
           * Marks a binding as mutable and unsupported for static values.
           *
           * Example: `let HTTP_ID = 'conn-http'`.
           */
          kind: 'mutable';
          /**
           * Original mutable declaration kind.
           *
           * Example: `let` or `var`.
           */
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
          /**
           * Marks a binding created from destructuring or another pattern.
           *
           * Example: `const { HTTP_ID } = CONNECTIONS`.
           */
          kind: 'unsupported-pattern';
      }
    /**
     * A top-level `const` binding that is assigned after declaration. This is
     * invalid at runtime, but if a parser accepts it we still fail closed.
     */
    | {
          /**
           * Marks a binding that is written after declaration.
           *
           * Example: `HTTP_ID = nextId()`.
           */
          kind: 'reassigned';
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
 *   pattern such as `const { HTTP } = CONNECTIONS`, which this resolver
 *   intentionally does not support.
 */
export interface SameModuleConnectionIdBindings {
    /**
     * Static binding facts keyed by eslint-scope variable identity.
     *
     * Example: the `HTTP_ID` variable from `const HTTP_ID = 'conn'` maps to a
     * `const` binding with the string literal initializer.
     */
    byVariable: Map<eslintScope.Variable, StaticBinding>;
}

/**
 * Shared state for one `connectionId` value resolution.
 *
 * `seen` tracks the const declarations currently being followed. It prevents
 * infinite recursion for cycles such as `const A = B; const B = A;`.
 */
interface ConnectionIdResolutionContext {
    /**
     * Same-module binding facts available to this resolution.
     *
     * Example: `HTTP_ID` can resolve through `const HTTP_ID = 'conn'`.
     */
    bindings: SameModuleConnectionIdBindings;
    /**
     * Current file path used in fail-closed diagnostics.
     *
     * Example: `/project/src/backend/actions.backend.ts`.
     */
    filePath: string;
    /**
     * Optional graph-aware resolver for imported identifiers and object roots.
     *
     * Example: resolves `import { HTTP_ID } from './ids.js'`.
     */
    importResolver?: ImportedConnectionIdResolver;
    /**
     * eslint-scope analysis for resolving identifiers to declaration identity.
     *
     * Example: distinguishes top-level `HTTP_ID` from a shadowed parameter with
     * the same name.
     */
    scopeAnalysis: ScopeAnalysis;
    /**
     * Variables currently being resolved through const chains.
     *
     * Example: catches `const A = B; const B = A`.
     */
    seen: Set<eslintScope.Variable>;
}

/**
 * Imported expression plus the resolution context from its source module.
 *
 * Example: resolving `import { CONNECTIONS } from './ids.js'` returns the
 * `CONNECTIONS` initializer expression and the `ids.js` binding context.
 */
export interface ImportedConnectionIdValue {
    /**
     * Resolution context for the module that owns `expression`.
     *
     * Example: the context for `ids.js`, not the importing helper module.
     */
    context: ConnectionIdResolutionContextInput;
    /**
     * Source expression that should be resolved by the shared value resolver.
     *
     * Example: the object literal from `export const CONNECTIONS = {...}`.
     */
    expression: Expression;
    /**
     * Optional cleanup callback for import/export cycle tracking.
     *
     * Example: releases the active `ids.js\0CONNECTIONS` export key after the
     * caller has resolved the returned expression.
     */
    release?: () => void;
}

/**
 * Graph-aware imported value resolver used by same-module value resolution.
 *
 * Example: when `connectionId: HTTP_ID` references an imported variable, this
 * resolver follows the import to the exported value expression.
 */
export interface ImportedConnectionIdResolver {
    /**
     * Resolves one imported local variable to its exported value expression.
     *
     * Example: local `ACTIVE_ID` from
     * `import { HTTP_ID as ACTIVE_ID } from './ids.js'`.
     */
    resolveImportedConnectionIdValue: (
        variable: eslintScope.Variable,
        localName: string,
        filePath: string,
    ) => ImportedConnectionIdValue;
}

/**
 * Serializable subset of connection ID resolution context that can be passed
 * between modules.
 *
 * Example: import tracing can hand the `ids.js` bindings and scope analysis
 * back to the same value resolver used by the importing helper.
 */
export interface ConnectionIdResolutionContextInput {
    /**
     * Same-module binding facts for the module being resolved.
     *
     * Example: bindings collected from `ids.js`.
     */
    bindings: SameModuleConnectionIdBindings;
    /**
     * File path for the module being resolved.
     *
     * Example: `/project/src/backend/ids.js`.
     */
    filePath: string;
    /**
     * Optional resolver to continue through additional imported values.
     *
     * Example: `ids.js` can itself re-export from `shared-ids.js`.
     */
    importResolver?: ImportedConnectionIdResolver;
    /**
     * Scope analysis for identifier lookup in the module being resolved.
     *
     * Example: resolves `BASE_ID` in `export const HTTP_ID = BASE_ID`.
     */
    scopeAnalysis: ScopeAnalysis;
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
 * aliasing behavior than the resolver supports.
 */
export function collectSameModuleConnectionIdBindings(
    ast: Program,
    scopeAnalysis: ScopeAnalysis,
): SameModuleConnectionIdBindings {
    const byVariable = new Map<eslintScope.Variable, StaticBinding>();

    for (const node of ast.body) {
        // Top-level declarations such as:
        //   const HTTP_CONNECTION_ID = 'abc';
        //   const CONNECTIONS = { HTTP: 'abc' };
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

    markReassignedBindings(ast, scopeAnalysis, byVariable);

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
    importResolver?: ImportedConnectionIdResolver,
): string | undefined {
    const [firstArg] = node.arguments;
    if (!firstArg || firstArg.type !== 'ObjectExpression') {
        // Example: `request(options)` could hide a `connectionId`, so only
        // inline object arguments are accepted.
        throw unsupportedActionCatalogCall(filePath, 'non-object action-catalog call arguments');
    }

    const connectionIdProperty = findConnectionIdProperty(firstArg, filePath);
    if (!connectionIdProperty) {
        // Example: `request({ inputs: {} })` does not request a connection and
        // therefore contributes no allowlist entry.
        return undefined;
    }

    return resolveConnectionIdValue(connectionIdProperty.value, {
        bindings,
        filePath,
        importResolver,
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

        // Destructuring creates variables, but this resolver does not follow
        // destructured aliases:
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
        //   const CONNECTIONS = { HTTP: HTTP_CONNECTION_ID };
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
 * Marks top-level bindings as reassigned when the file writes to them after
 * declaration.
 *
 * Example:
 *
 * ```ts
 * const HTTP_ID = 'conn';
 * HTTP_ID = nextId();
 * ```
 *
 * records `HTTP_ID` as `reassigned` so connection ID extraction fails closed.
 */
function markReassignedBindings(
    ast: Program,
    scopeAnalysis: ScopeAnalysis,
    byVariable: Map<eslintScope.Variable, StaticBinding>,
): void {
    walkAst(ast, undefined, {
        AssignmentExpression(node) {
            // Example: `HTTP_ID = nextId()` or `{ HTTP_ID } = nextIds()`.
            for (const identifier of getPatternIdentifiers(node.left)) {
                markReassignedBinding(identifier, scopeAnalysis, byVariable);
            }
        },
        UpdateExpression(node: UpdateExpression) {
            // Example: `HTTP_ID++`. This is invalid for string constants, but
            // if parsed it still means the binding is not trustworthy.
            for (const identifier of getPatternIdentifiers(node.argument)) {
                markReassignedBinding(identifier, scopeAnalysis, byVariable);
            }
        },
    });
}

/**
 * Marks one identifier's tracked binding as reassigned.
 *
 * Example: the `HTTP_ID` identifier in `HTTP_ID = nextId()` updates the
 * top-level `HTTP_ID` binding if that binding is part of connection ID analysis.
 */
function markReassignedBinding(
    identifier: Identifier,
    scopeAnalysis: ScopeAnalysis,
    byVariable: Map<eslintScope.Variable, StaticBinding>,
): void {
    const variable = resolveIdentifier(identifier, scopeAnalysis);
    if (!variable || !byVariable.has(variable)) {
        // Example: assignment to a local helper variable or unresolved global
        // does not affect top-level connection ID binding facts.
        return;
    }
    byVariable.set(variable, { kind: 'reassigned' });
}

/**
 * Extracts all identifiers written by an assignment or update target pattern.
 *
 * Example:
 *
 * ```ts
 * HTTP_ID = nextId();
 * ({ HTTP_ID } = nextIds());
 * [HTTP_ID] = nextIds();
 * ```
 *
 * returns the identifiers that should be marked as reassigned.
 */
function getPatternIdentifiers(pattern: Pattern | Expression): Identifier[] {
    switch (pattern.type) {
        case 'Identifier':
            // Example: `HTTP_ID = nextId()`.
            return [pattern];
        case 'ArrayPattern':
            // Example: `[HTTP_ID] = nextIds()`.
            return pattern.elements.flatMap((element) =>
                element ? getPatternIdentifiers(element) : [],
            );
        case 'ObjectPattern':
            // Example: `({ HTTP_ID } = nextIds())`.
            return pattern.properties.flatMap((property) => {
                if (property.type === 'RestElement') {
                    // Example: `({ ...rest } = nextIds())`.
                    return getPatternIdentifiers(property.argument);
                }
                return getPatternIdentifiers(property.value);
            });
        case 'RestElement':
            // Example: `[...ids] = nextIds()`.
            return getPatternIdentifiers(pattern.argument);
        case 'AssignmentPattern':
            // Example: `({ HTTP_ID = fallback } = nextIds())`.
            return getPatternIdentifiers(pattern.left);
        default:
            // Example: `member.value = nextId()` is not a binding identifier.
            return [];
    }
}

/**
 * Resolves one ESTree expression into the final connection ID string.
 *
 * This is the dispatcher for the shapes this resolver supports:
 *
 * - `'abc'`
 * - `` `abc` ``
 * - `HTTP_CONNECTION_ID`
 * - `CONNECTIONS.HTTP`
 * - `CONNECTIONS.HTTP.PROD`
 *
 * Any other expression, such as `getId()` or `'a' + suffix`, fails closed.
 */
function resolveConnectionIdValue(
    node: Expression,
    context: ConnectionIdResolutionContext,
): string {
    switch (node.type) {
        case 'Literal':
            // Example: `connectionId: 'conn-http'`.
            return resolveLiteral(node, context.filePath);
        case 'TemplateLiteral':
            // Example: `` connectionId: `conn-http` ``.
            return resolveTemplateLiteral(node, context.filePath);
        case 'Identifier':
            // Example: `connectionId: HTTP_ID`.
            return resolveIdentifierValue(node, context);
        case 'MemberExpression':
            // Example: `connectionId: CONNECTIONS.HTTP.PROD`.
            return resolveObjectMemberValue(node, context);
        default:
            // Example: `connectionId: getConnectionId()` is not statically
            // safe to put in the manifest allowlist.
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
        // Example: `connectionId: 'conn-http'`.
        return node.value;
    }
    // Example: `connectionId: 123` is a literal, but not a string ID.
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
        // Example: `` connectionId: `${prefix}-http` `` depends on runtime
        // interpolation and cannot be included safely.
        throw unsupportedConnectionId(filePath, 'dynamic template literals');
    }

    // Example: `` connectionId: `conn-http` `` is fully static.
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
        if (context.importResolver) {
            const imported = context.importResolver.resolveImportedConnectionIdValue(
                variable,
                identifier.name,
                context.filePath,
            );
            try {
                return resolveConnectionIdValue(imported.expression, {
                    ...imported.context,
                    seen: context.seen,
                });
            } finally {
                imported.release?.();
            }
        }

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
        case 'reassigned':
            throw unsupportedConnectionId(
                context.filePath,
                `reassigned connectionId binding ${identifier.name}`,
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
 * Resolves an object member read from a top-level const object.
 *
 * Example:
 *
 * ```ts
 * const CONNECTIONS = { HTTP: 'abc' };
 * request({ connectionId: CONNECTIONS.HTTP });
 * ```
 *
 * This supports static property chains such as `IDENTIFIER.STATIC.PROPERTY`.
 * Computed reads like `CONNECTIONS[key]` and imported objects are rejected
 * because they need module graph analysis.
 */
function resolveObjectMemberValue(
    node: MemberExpression,
    context: ConnectionIdResolutionContext,
): string {
    // Look up the member access and return the raw expression stored in the
    // object literal. For `const CONNECTIONS = { HTTP: 'conn-http' }`,
    // resolving `CONNECTIONS.HTTP` returns the string literal expression
    // `'conn-http'`. For `const CONNECTIONS = { HTTP: HTTP_CONNECTION_ID }`,
    // it returns the identifier expression `HTTP_CONNECTION_ID`.
    const value = resolveObjectMemberExpression(node, context);

    // Resolve the returned expression through the same dispatcher used for
    // direct `connectionId` values. For `const CONNECTIONS = { HTTP: 'conn-http' }`,
    // the string literal can become the final connection ID immediately. For
    // `const CONNECTIONS = { HTTP: HTTP_CONNECTION_ID }`, the identifier can
    // resolve through its own const binding before producing the final string.
    return resolveConnectionIdValue(value.expression, value.context);
}

/**
 * Resolved expression plus the module context required to keep resolving it.
 *
 * Example: resolving `CONNECTIONS.HTTP` returns the expression stored at
 * property `HTTP` and the context where `CONNECTIONS` was declared.
 */
interface ResolvedConnectionIdExpression {
    /**
     * Context for resolving identifiers inside `expression`.
     *
     * Example: imported object members keep the source module context.
     */
    context: ConnectionIdResolutionContext;
    /**
     * Expression selected by a connection ID lookup.
     *
     * Example: the `'conn-http'` literal inside `{ HTTP: 'conn-http' }`.
     */
    expression: Expression;
}

/**
 * Resolved static object expression plus the module context that owns it.
 *
 * Example: resolving imported `CONNECTIONS` returns the object literal from
 * `ids.ts` and the `ids.ts` resolution context.
 */
interface ResolvedObjectExpression {
    /**
     * Context for resolving nested object values.
     *
     * Example: `CONNECTIONS.HTTP.PROD` keeps the context where `CONNECTIONS`
     * was defined.
     */
    context: ConnectionIdResolutionContext;
    /**
     * Static object expression that can be inspected for property values.
     *
     * Example: `{ HTTP: { PROD: 'conn' } }`.
     */
    expression: ObjectExpression;
}

/**
 * Resolves one member read and returns the property value expression.
 *
 * For `CONNECTIONS.HTTP.PROD`, the outer read asks for `PROD`. This helper
 * first resolves `CONNECTIONS.HTTP` to an object expression, then returns the
 * expression stored at its `PROD` property.
 */
function resolveObjectMemberExpression(
    node: MemberExpression,
    context: ConnectionIdResolutionContext,
): ResolvedConnectionIdExpression {
    if (node.optional) {
        // Example: `CONNECTIONS?.HTTP` can produce `undefined` at runtime and
        // is not a statically guaranteed connection ID.
        throw unsupportedConnectionId(context.filePath, 'optional connectionId member reads');
    }
    // We only support dot property names because the key is visible in source:
    //   CONNECTIONS.HTTP
    // Dynamic keys are left for a future, more complete resolver:
    //   CONNECTIONS[key]
    if (node.computed) {
        throw unsupportedConnectionId(context.filePath, 'computed connectionId member reads');
    }
    if (node.property.type !== 'Identifier') {
        throw unsupportedConnectionId(
            context.filePath,
            'non-static connectionId member properties',
        );
    }

    const objectExpression = resolveObjectExpressionValue(node.object, context);
    return resolveObjectPropertyExpression(
        objectExpression.expression,
        node.property.name,
        objectExpression.context,
    );
}

/**
 * Resolves an expression that is expected to be a static object value.
 *
 * Supported examples:
 *
 * ```ts
 * const CONNECTIONS = { HTTP: { PROD: 'abc' } };
 * const ACTIVE_CONNECTIONS = CONNECTIONS;
 * request({ connectionId: ACTIVE_CONNECTIONS.HTTP.PROD });
 * ```
 */
function resolveObjectExpressionValue(
    node: MemberExpression['object'] | Expression,
    context: ConnectionIdResolutionContext,
): ResolvedObjectExpression {
    if (node.type === 'ObjectExpression') {
        // Example: `{ HTTP: 'conn-http' }` can be inspected directly.
        return { context, expression: node };
    }

    if (node.type === 'MemberExpression') {
        // Example: resolving `CONNECTIONS.HTTP.PROD` first resolves
        // `CONNECTIONS.HTTP` to an object, then reads `PROD`.
        const resolved = resolveObjectMemberExpression(node, context);
        return resolveObjectExpressionValue(resolved.expression, resolved.context);
    }

    if (node.type !== 'Identifier') {
        // Example: `getConnections().HTTP` has a dynamic object root.
        throw unsupportedConnectionId(context.filePath, 'non-object connectionId member values');
    }

    const variable = resolveIdentifier(node, context.scopeAnalysis);
    if (!variable) {
        // Example: `CONNECTIONS.HTTP` with no `CONNECTIONS` declaration.
        throw unsupportedConnectionId(context.filePath, `unresolved object binding ${node.name}`);
    }
    // Imported maps require module graph analysis:
    //   import { CONNECTIONS } from './connections';
    //   request({ connectionId: CONNECTIONS.HTTP });
    if (isImportVariable(variable)) {
        if (context.importResolver) {
            const imported = context.importResolver.resolveImportedConnectionIdValue(
                variable,
                node.name,
                context.filePath,
            );
            try {
                return resolveObjectExpressionValue(imported.expression, {
                    ...imported.context,
                    seen: context.seen,
                });
            } finally {
                imported.release?.();
            }
        }

        throw unsupportedConnectionId(
            context.filePath,
            `imported connectionId object binding ${node.name}`,
        );
    }

    const binding = context.bindings.byVariable.get(variable);
    if (!binding) {
        // Example: a function-local `CONNECTIONS` object is not a top-level
        // binding tracked by this static resolver.
        throw unsupportedConnectionId(
            context.filePath,
            `non-top-level connectionId object binding ${node.name}`,
        );
    }
    if (binding.kind === 'mutable') {
        // A mutable map can change before the action call runs:
        //   let CONNECTIONS = { HTTP: 'abc' };
        //   CONNECTIONS = loadConnections();
        throw unsupportedConnectionId(
            context.filePath,
            `mutable ${binding.declarationKind} connectionId object binding ${node.name}`,
        );
    }
    if (binding.kind === 'unsupported-pattern') {
        // Destructured maps are not expected here, but keep the failure explicit
        // for consistency with direct identifier resolution.
        throw unsupportedConnectionId(
            context.filePath,
            `destructured connectionId object binding ${node.name}`,
        );
    }
    if (binding.kind === 'reassigned') {
        // Example: `const CONNECTIONS = {...}; CONNECTIONS = nextConnections`.
        throw unsupportedConnectionId(
            context.filePath,
            `reassigned connectionId object binding ${node.name}`,
        );
    }
    if (!binding.init) {
        // Example: parser edge cases around an uninitialized `const`.
        throw unsupportedConnectionId(
            context.filePath,
            `uninitialized const connectionId object binding ${node.name}`,
        );
    }

    if (context.seen.has(variable)) {
        // Const object aliases can reference each other; stop cycles before
        // recursion loops forever:
        //   const A = B;
        //   const B = A;
        throw unsupportedConnectionId(
            context.filePath,
            `cyclic connectionId object binding ${node.name}`,
        );
    }

    context.seen.add(variable);
    try {
        const objectExpression = resolveObjectExpressionValue(binding.init, context);
        // `CONNECTIONS.HTTP` only works when `CONNECTIONS` is visibly an object
        // literal in this file, directly or through const aliases:
        //   const CONNECTIONS = { HTTP: 'abc' };
        //   const ACTIVE_CONNECTIONS = CONNECTIONS;
        return objectExpression;
    } finally {
        context.seen.delete(variable);
    }
}

/**
 * Looks up one property in a const object expression and returns its value
 * expression without forcing that value to be a final string yet.
 *
 * This lets nested reads resolve one hop at a time. For
 * `CONNECTIONS.HTTP.PROD`, the `HTTP` lookup returns `{ PROD: 'abc' }`, and the
 * next lookup resolves `PROD` from that nested object.
 */
function resolveObjectPropertyExpression(
    objectExpression: ObjectExpression,
    propertyName: string,
    context: ConnectionIdResolutionContext,
): ResolvedConnectionIdExpression {
    let match: Property | undefined;

    for (const property of objectExpression.properties) {
        // Spreads can hide or override the property we are looking for:
        //   const CONNECTIONS = { ...baseConnections };
        if (property.type === 'SpreadElement') {
            throw unsupportedConnectionId(
                context.filePath,
                'object spreads in connectionId objects',
            );
        }
        // Computed keys are dynamic, even inside an object literal:
        //   const CONNECTIONS = { [key]: 'abc' };
        if (property.computed) {
            throw unsupportedConnectionId(
                context.filePath,
                'computed properties in connectionId objects',
            );
        }

        const key = getStaticPropertyKey(property);
        // Skip visible-but-unrelated keys while looking for the requested
        // member. For `CONNECTIONS.HTTP`, this skips `SLACK` and matches `HTTP`:
        //   const CONNECTIONS = { SLACK: 'slack-id', HTTP: 'http-id' };
        if (key !== propertyName) {
            continue;
        }
        if (match) {
            // Duplicate keys make the effective value depend on object literal
            // overwrite rules, so reject instead of guessing:
            //   const CONNECTIONS = { HTTP: 'a', HTTP: 'b' };
            throw unsupportedConnectionId(
                context.filePath,
                `duplicate property ${propertyName} in connectionId object`,
            );
        }
        if (property.kind !== 'init') {
            // Getters can run arbitrary code, so they are not static values:
            //   const CONNECTIONS = { get HTTP() { return getId(); } };
            throw unsupportedConnectionId(
                context.filePath,
                `accessor property ${propertyName} in connectionId object`,
            );
        }
        match = property;
    }

    if (!match) {
        // The call asked for a property that is not visibly present:
        //   const CONNECTIONS = { SLACK: 'abc' };
        //   request({ connectionId: CONNECTIONS.HTTP });
        throw unsupportedConnectionId(
            context.filePath,
            `missing property ${propertyName} in connectionId object`,
        );
    }

    return { context, expression: match.value as Expression };
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
            // Example: `request({ ...options })` could hide `connectionId`.
            throw unsupportedActionCatalogCall(filePath, 'spread object arguments');
        }
        if (property.computed) {
            // Example: `request({ [key]: HTTP_ID })` could produce
            // `connectionId` at runtime.
            throw unsupportedActionCatalogCall(filePath, 'computed object property keys');
        }
        if (isConnectionIdKey(property)) {
            if (connectionIdProperty) {
                // Example: duplicate `connectionId` keys rely on object
                // overwrite semantics, so reject instead of guessing.
                throw unsupportedActionCatalogCall(filePath, 'multiple connectionId properties');
            }
            if (property.kind !== 'init') {
                // Example: `get connectionId() { return getId(); }` can run
                // arbitrary code.
                throw unsupportedActionCatalogCall(filePath, 'accessor connectionId properties');
            }
            if (!hasExpressionValue(property)) {
                // Example: parser pattern values are not connection ID
                // expressions this resolver can evaluate.
                throw unsupportedActionCatalogCall(
                    filePath,
                    'destructuring pattern in connectionId value',
                );
            }
            // Example: `request({ connectionId: HTTP_ID, inputs: {} })`.
            connectionIdProperty = property;
        }
    }
    return connectionIdProperty;
}

/**
 * Narrows an object property to one whose value is an expression.
 *
 * Example: `{ connectionId: HTTP_ID }` returns true, while parser pattern
 * values are rejected so value resolution never sees destructuring nodes.
 */
function hasExpressionValue(property: Property): property is ConnectionIdProperty {
    const { value } = property;
    return (
        value.type !== 'ObjectPattern' &&
        value.type !== 'ArrayPattern' &&
        value.type !== 'RestElement' &&
        value.type !== 'AssignmentPattern'
    );
}

/**
 * Checks whether an object property is the action-catalog `connectionId` key.
 *
 * Example: matches `{ connectionId: HTTP_ID }` and `{ 'connectionId': HTTP_ID }`.
 */
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
        // Example: `{ HTTP: 'conn-http' }`.
        return property.key.name;
    }
    if (property.key.type === 'Literal' && typeof property.key.value === 'string') {
        // Example: `{ 'HTTP': 'conn-http' }`.
        return property.key.value;
    }
    // Example: `{ [key]: 'conn-http' }` has no statically visible key.
    return undefined;
}

/**
 * Builds the common fail-closed error for unsupported action-catalog call
 * shapes.
 *
 * Example: `request(options)` could hide `connectionId`, so it reports an
 * unsupported non-object action-catalog call.
 */
function unsupportedActionCatalogCall(filePath: string, unsupported: string): Error {
    return new Error(
        `Unsupported action-catalog call in ${filePath}: ${unsupported} could hide a connectionId.`,
    );
}

/**
 * Builds the common fail-closed error for unsupported connection ID values.
 *
 * Example: `connectionId: getId()` reports an unsupported call-expression
 * connection ID value instead of silently omitting it from the manifest.
 */
function unsupportedConnectionId(filePath: string, unsupported: string): Error {
    return new Error(`Unsupported action-catalog connectionId in ${filePath}: ${unsupported}.`);
}
