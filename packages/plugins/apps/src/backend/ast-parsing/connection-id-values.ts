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
    Property,
    SimpleCallExpression,
    TemplateLiteral,
} from 'estree';

import type { ParsedModuleRecord } from './module-graph';
import type { ModuleScopeAnalysis } from './module-scope';
import {
    resolveStaticDefinitionForIdentifier,
    type LocalStaticDefinition,
    type UnsupportedStaticDefinition,
} from './static-definition-resolution';

const CONNECTION_ID_PROPERTY = 'connectionId';

type ConnectionIdProperty = Property & { value: Expression };

export interface ModuleGraphConnectionIdResolutionContext {
    modules: ReadonlyMap<string, ParsedModuleRecord>;
    moduleId: string;
}

/**
 * Shared state for one `connectionId` value resolution.
 *
 * `seen` tracks the const declarations currently being followed. It prevents
 * infinite recursion for cycles such as `const A = B; const B = A;`.
 */
interface ConnectionIdResolutionContext {
    filePath: string;
    moduleGraph: ModuleGraphConnectionIdResolutionContext;
    scopeAnalysis: ModuleScopeAnalysis;
    seen: Set<eslintScope.Variable>;
}

interface ResolvedConnectionIdExpression {
    expression: Expression;
    context: ConnectionIdResolutionContext;
}

interface ResolvedObjectExpression {
    expression: ObjectExpression;
    context: ConnectionIdResolutionContext;
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
    scopeAnalysis: ModuleScopeAnalysis,
    filePath: string,
    moduleGraph: ModuleGraphConnectionIdResolutionContext,
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
        filePath,
        moduleGraph,
        scopeAnalysis,
        seen: new Set(),
    });
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
            return resolveLiteral(node, context.filePath);
        case 'TemplateLiteral':
            return resolveTemplateLiteral(node, context.filePath);
        case 'Identifier':
            return resolveIdentifierValue(node, context);
        case 'MemberExpression':
            return resolveObjectMemberValue(node, context);
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
    const definition = resolveStaticDefinitionForIdentifier(
        context.moduleGraph.modules,
        context.moduleGraph.moduleId,
        identifier,
    );

    if (definition.kind === 'unsupported') {
        throw unsupportedStaticDefinitionConnectionId(context.filePath, identifier, definition);
    }

    return resolveLocalStaticDefinitionValue(definition, context);
}

function resolveLocalStaticDefinitionValue(
    definition: LocalStaticDefinition,
    context: ConnectionIdResolutionContext,
): string {
    if (!definition.binding.expression) {
        throw unsupportedConnectionId(
            definition.moduleId,
            `uninitialized const connectionId binding ${definition.variable.name}`,
        );
    }
    if (context.seen.has(definition.variable)) {
        throw unsupportedConnectionId(
            definition.moduleId,
            `cyclic connectionId binding ${definition.variable.name}`,
        );
    }

    const definitionContext = getModuleConnectionIdContext(context, definition.moduleId);

    context.seen.add(definition.variable);
    try {
        return resolveConnectionIdValue(definition.binding.expression, definitionContext);
    } finally {
        context.seen.delete(definition.variable);
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
    return {
        expression: resolveObjectPropertyExpression(
            objectExpression.expression,
            node.property.name,
            objectExpression.context,
        ),
        context: objectExpression.context,
    };
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
        return { expression: node, context };
    }

    if (node.type === 'MemberExpression') {
        const value = resolveObjectMemberExpression(node, context);
        return resolveObjectExpressionValue(value.expression, value.context);
    }

    if (node.type !== 'Identifier') {
        throw unsupportedConnectionId(context.filePath, 'non-object connectionId member values');
    }

    const definition = resolveStaticDefinitionForIdentifier(
        context.moduleGraph.modules,
        context.moduleGraph.moduleId,
        node,
    );

    if (definition.kind === 'unsupported') {
        throw unsupportedStaticDefinitionConnectionId(context.filePath, node, definition);
    }
    if (!definition.binding.expression) {
        throw unsupportedConnectionId(
            definition.moduleId,
            `uninitialized const connectionId object binding ${definition.variable.name}`,
        );
    }
    if (context.seen.has(definition.variable)) {
        throw unsupportedConnectionId(
            definition.moduleId,
            `cyclic connectionId object binding ${definition.variable.name}`,
        );
    }

    const definitionContext = getModuleConnectionIdContext(context, definition.moduleId);
    context.seen.add(definition.variable);
    try {
        return resolveObjectExpressionValue(definition.binding.expression, definitionContext);
    } finally {
        context.seen.delete(definition.variable);
    }
}

function getModuleConnectionIdContext(
    context: ConnectionIdResolutionContext,
    moduleId: string,
): ConnectionIdResolutionContext {
    const moduleGraph = context.moduleGraph;
    if (moduleGraph.moduleId === moduleId) {
        return context;
    }

    const record = moduleGraph.modules.get(moduleId);
    if (!record) {
        throw unsupportedConnectionId(
            context.filePath,
            `missing module record while resolving connectionId binding ${moduleId}`,
        );
    }

    return {
        filePath: moduleId,
        moduleGraph: {
            modules: moduleGraph.modules,
            moduleId,
        },
        scopeAnalysis: record.scopeAnalysis,
        seen: context.seen,
    };
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
): Expression {
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

    return match.value as Expression;
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

function unsupportedStaticDefinitionConnectionId(
    filePath: string,
    identifier: Identifier,
    definition: UnsupportedStaticDefinition,
): Error {
    return unsupportedConnectionId(
        filePath,
        `unsupported static definition ${definition.reason} for ${identifier.name}: ${definition.message}`,
    );
}

function unsupportedConnectionId(filePath: string, unsupported: string): Error {
    return new Error(`Unsupported action-catalog connectionId in ${filePath}: ${unsupported}.`);
}
