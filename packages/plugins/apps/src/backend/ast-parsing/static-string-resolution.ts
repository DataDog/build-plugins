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
    Property,
    Super,
    TemplateLiteral,
    VariableDeclaration,
    VariableDeclarator,
} from 'estree';

import type { ParsedModuleRecord } from './module-graph';
import { isImportVariable, resolveIdentifier } from './module-scope';
import {
    resolveStaticDefinitionForIdentifier,
    type UnsupportedStaticDefinition,
} from './static-definition-resolution';
import { walkAst } from './walk-ast';

export type StaticStringValueResolution = ResolvedStaticStringValue | UnsupportedStaticStringValue;

export interface ResolvedStaticStringValue {
    kind: 'resolved';
    moduleId: string;
    value: string;
}

export type UnsupportedStaticStringValue =
    | AccessorObjectPropertyStaticStringValue
    | ComputedMemberExpressionStaticStringValue
    | ComputedObjectPropertyStaticStringValue
    | CycleStaticStringValue
    | DuplicateObjectPropertyStaticStringValue
    | DynamicTemplateLiteralStaticStringValue
    | ImportedObjectMutationStaticStringValue
    | MissingObjectPropertyStaticStringValue
    | NonObjectMemberValueStaticStringValue
    | NonStaticMemberPropertyStaticStringValue
    | NonStringLiteralStaticStringValue
    | ObjectSpreadStaticStringValue
    | OptionalMemberExpressionStaticStringValue
    | StaticDefinitionUnsupportedStaticStringValue
    | UninitializedConstStaticStringValue
    | UnsupportedExpressionStaticStringValue
    | UnsupportedObjectPropertyValueStaticStringValue;

export type StaticStringValueUnsupportedReason = UnsupportedStaticStringValue['reason'];

interface UnsupportedStaticStringValueBase {
    kind: 'unsupported';
    moduleId: string;
    message: string;
}

// Example: const CONNECTIONS = { get HTTP() { return 'conn-http'; } };
export interface AccessorObjectPropertyStaticStringValue extends UnsupportedStaticStringValueBase {
    reason: 'accessor-object-property';
    propertyName: string;
}

// Example: CONNECTIONS[key]
export interface ComputedMemberExpressionStaticStringValue
    extends UnsupportedStaticStringValueBase {
    reason: 'computed-member-expression';
}

// Example: const CONNECTIONS = { [key]: 'conn-http' };
export interface ComputedObjectPropertyStaticStringValue extends UnsupportedStaticStringValueBase {
    reason: 'computed-object-property';
}

// Example: const A = B; const B = A;
export interface CycleStaticStringValue extends UnsupportedStaticStringValueBase {
    reason: 'cycle';
    variableName: string;
}

// Example: const CONNECTIONS = { HTTP: 'a', HTTP: 'b' };
export interface DuplicateObjectPropertyStaticStringValue extends UnsupportedStaticStringValueBase {
    reason: 'duplicate-object-property';
    propertyName: string;
}

// Example: const VALUE = `${prefix}-http`;
export interface DynamicTemplateLiteralStaticStringValue extends UnsupportedStaticStringValueBase {
    reason: 'dynamic-template-literal';
}

// Example: import { CONNECTIONS } from './ids.js'; CONNECTIONS.HTTP = 'conn-b';
export interface ImportedObjectMutationStaticStringValue extends UnsupportedStaticStringValueBase {
    reason: 'imported-object-mutation';
    variableName: string;
}

// Example: const CONNECTIONS = { SLACK: 'conn-slack' }; CONNECTIONS.HTTP
export interface MissingObjectPropertyStaticStringValue extends UnsupportedStaticStringValueBase {
    reason: 'missing-object-property';
    propertyName: string;
}

// Example: const CONNECTIONS = { HTTP: 'conn-http' }; CONNECTIONS.HTTP.PROD
export interface NonObjectMemberValueStaticStringValue extends UnsupportedStaticStringValueBase {
    reason: 'non-object-member-value';
    expressionType: string;
}

// Example: object.#privateValue
export interface NonStaticMemberPropertyStaticStringValue extends UnsupportedStaticStringValueBase {
    reason: 'non-static-member-property';
    propertyType: string;
}

// Example: const VALUE = 123;
export interface NonStringLiteralStaticStringValue extends UnsupportedStaticStringValueBase {
    reason: 'non-string-literal';
    valueType: string;
}

// Example: const CONNECTIONS = { ...baseConnections };
export interface ObjectSpreadStaticStringValue extends UnsupportedStaticStringValueBase {
    reason: 'object-spread';
}

// Example: CONNECTIONS?.HTTP
export interface OptionalMemberExpressionStaticStringValue
    extends UnsupportedStaticStringValueBase {
    reason: 'optional-member-expression';
}

// Example: import HTTP_ID from './ids.js';
export interface StaticDefinitionUnsupportedStaticStringValue
    extends UnsupportedStaticStringValueBase {
    reason: 'static-definition-unsupported';
    variableName: string;
    definition: UnsupportedStaticDefinition;
}

// Defensive parser edge: a const binding exists without an initializer expression.
export interface UninitializedConstStaticStringValue extends UnsupportedStaticStringValueBase {
    reason: 'uninitialized-const';
    variableName: string;
}

// Example: getConnectionId()
export interface UnsupportedExpressionStaticStringValue extends UnsupportedStaticStringValueBase {
    reason: 'unsupported-expression';
    expressionType: string;
}

// Defensive parser edge: an object property value is a pattern instead of an expression.
export interface UnsupportedObjectPropertyValueStaticStringValue
    extends UnsupportedStaticStringValueBase {
    reason: 'unsupported-object-property-value';
    propertyName: string;
    valueType: string;
}

interface ResolverState {
    modules: ReadonlyMap<string, ParsedModuleRecord>;
    mutatedImportedObjectVariables: ReadonlySet<eslintScope.Variable>;
    seenVariables: Set<eslintScope.Variable>;
}

interface ImportedObjectMutationState {
    modules: ReadonlyMap<string, ParsedModuleRecord>;
    mutatedVariables: Set<eslintScope.Variable>;
    record: ParsedModuleRecord;
}

interface ResolvedStaticExpression {
    kind: 'resolved';
    moduleId: string;
    expression: Expression;
}

type StaticExpressionResolution = ResolvedStaticExpression | UnsupportedStaticStringValue;

interface ResolvedStaticObjectExpression {
    kind: 'resolved';
    moduleId: string;
    expression: ObjectExpression;
}

type StaticObjectExpressionResolution =
    | ResolvedStaticObjectExpression
    | UnsupportedStaticStringValue;

type StaticObjectProperty = Property & { value: Expression };

type TypeScriptExpressionWrapper = Expression & {
    expression?: Expression;
};

export function resolveStaticStringValue(
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    moduleId: string,
    expression: Expression,
): StaticStringValueResolution {
    return resolveExpression(
        {
            modules,
            mutatedImportedObjectVariables: collectMutatedImportedObjectVariables(modules),
            seenVariables: new Set(),
        },
        moduleId,
        expression,
    );
}

function resolveExpression(
    state: ResolverState,
    moduleId: string,
    rawExpression: Expression,
): StaticStringValueResolution {
    const expression = unwrapStaticExpression(rawExpression);

    switch (expression.type) {
        case 'Literal':
            return resolveLiteral(moduleId, expression);
        case 'TemplateLiteral':
            return resolveTemplateLiteral(moduleId, expression);
        case 'Identifier':
            return resolveIdentifierValue(state, moduleId, expression);
        case 'MemberExpression':
            return resolveMemberExpressionValue(state, moduleId, expression);
        default:
            return unsupportedExpression(moduleId, expression.type);
    }
}

function resolveLiteral(moduleId: string, expression: Literal): StaticStringValueResolution {
    if (typeof expression.value === 'string') {
        return {
            kind: 'resolved',
            moduleId,
            value: expression.value,
        };
    }

    return unsupportedNonStringLiteral(moduleId, typeof expression.value);
}

function resolveTemplateLiteral(
    moduleId: string,
    expression: TemplateLiteral,
): StaticStringValueResolution {
    if (expression.expressions.length > 0) {
        return unsupportedDynamicTemplateLiteral(moduleId);
    }

    return {
        kind: 'resolved',
        moduleId,
        value: expression.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(''),
    };
}

function resolveIdentifierValue(
    state: ResolverState,
    moduleId: string,
    identifier: Identifier,
): StaticStringValueResolution {
    // Follow local bindings, imports, and exports to the const definition that owns the value.
    const definition = resolveStaticDefinitionForIdentifier(state.modules, moduleId, identifier);

    if (definition.kind === 'unsupported') {
        return unsupportedStaticDefinition(definition, identifier.name);
    }

    if (!definition.binding.expression) {
        return unsupportedUninitializedConst(definition.moduleId, definition.variable.name);
    }

    // Track the resolved variable so aliases and reexports share the same cycle guard.
    if (state.seenVariables.has(definition.variable)) {
        return unsupportedCycle(definition.moduleId, definition.variable.name);
    }

    state.seenVariables.add(definition.variable);
    try {
        return resolveExpression(state, definition.moduleId, definition.binding.expression);
    } finally {
        state.seenVariables.delete(definition.variable);
    }
}

function resolveMemberExpressionValue(
    state: ResolverState,
    moduleId: string,
    expression: MemberExpression,
): StaticStringValueResolution {
    const resolvedExpression = resolveObjectMemberExpression(state, moduleId, expression);
    if (resolvedExpression.kind === 'unsupported') {
        return resolvedExpression;
    }

    return resolveExpression(state, resolvedExpression.moduleId, resolvedExpression.expression);
}

function resolveObjectMemberExpression(
    state: ResolverState,
    moduleId: string,
    expression: MemberExpression,
): StaticExpressionResolution {
    if (expression.optional) {
        // Example: CONNECTIONS?.HTTP
        return unsupportedOptionalMemberExpression(moduleId);
    }
    if (expression.computed) {
        // Example: CONNECTIONS[key]
        return unsupportedComputedMemberExpression(moduleId);
    }
    if (expression.property.type !== 'Identifier') {
        return unsupportedNonStaticMemberProperty(moduleId, expression.property.type);
    }

    const objectExpression = resolveObjectExpressionValue(state, moduleId, expression.object);
    if (objectExpression.kind === 'unsupported') {
        return objectExpression;
    }

    return resolveObjectPropertyExpression(
        objectExpression.moduleId,
        objectExpression.expression,
        expression.property.name,
    );
}

function resolveObjectExpressionValue(
    state: ResolverState,
    moduleId: string,
    rawExpression: Expression | Super,
): StaticObjectExpressionResolution {
    if (rawExpression.type === 'Super') {
        return unsupportedNonObjectMemberValue(moduleId, rawExpression.type);
    }

    const expression = unwrapStaticExpression(rawExpression);

    if (expression.type === 'ObjectExpression') {
        return {
            kind: 'resolved',
            moduleId,
            expression,
        };
    }

    if (expression.type === 'MemberExpression') {
        const memberExpression = resolveObjectMemberExpression(state, moduleId, expression);
        if (memberExpression.kind === 'unsupported') {
            return memberExpression;
        }

        return resolveObjectExpressionValue(
            state,
            memberExpression.moduleId,
            memberExpression.expression,
        );
    }

    if (expression.type !== 'Identifier') {
        return unsupportedNonObjectMemberValue(moduleId, expression.type);
    }

    const definition = resolveStaticDefinitionForIdentifier(state.modules, moduleId, expression);

    if (definition.kind === 'unsupported') {
        return unsupportedStaticDefinition(definition, expression.name);
    }

    if (!definition.binding.expression) {
        return unsupportedUninitializedConst(definition.moduleId, definition.variable.name);
    }

    if (state.mutatedImportedObjectVariables.has(definition.variable)) {
        return unsupportedImportedObjectMutation(definition.moduleId, definition.variable.name);
    }

    if (state.seenVariables.has(definition.variable)) {
        return unsupportedCycle(definition.moduleId, definition.variable.name);
    }

    state.seenVariables.add(definition.variable);
    try {
        return resolveObjectExpressionValue(
            state,
            definition.moduleId,
            definition.binding.expression,
        );
    } finally {
        state.seenVariables.delete(definition.variable);
    }
}

function resolveObjectPropertyExpression(
    moduleId: string,
    objectExpression: ObjectExpression,
    propertyName: string,
): StaticExpressionResolution {
    let match: StaticObjectProperty | undefined;

    for (const property of objectExpression.properties) {
        if (property.type === 'SpreadElement') {
            // Example: const CONNECTIONS = { ...baseConnections };
            return unsupportedObjectSpread(moduleId);
        }
        if (property.computed) {
            // Example: const CONNECTIONS = { [key]: 'conn-http' };
            return unsupportedComputedObjectProperty(moduleId);
        }

        const key = getStaticPropertyKey(property);
        if (key !== propertyName) {
            continue;
        }

        if (match) {
            // Example: const CONNECTIONS = { HTTP: 'a', HTTP: 'b' };
            return unsupportedDuplicateObjectProperty(moduleId, propertyName);
        }
        if (property.kind !== 'init') {
            // Example: const CONNECTIONS = { get HTTP() { return 'conn-http'; } };
            return unsupportedAccessorObjectProperty(moduleId, propertyName);
        }
        if (!hasExpressionValue(property)) {
            return unsupportedObjectPropertyValue(moduleId, propertyName, property.value.type);
        }

        match = property;
    }

    if (!match) {
        return unsupportedMissingObjectProperty(moduleId, propertyName);
    }

    return {
        kind: 'resolved',
        moduleId,
        expression: match.value,
    };
}

function hasExpressionValue(property: Property): property is Property & { value: Expression } {
    const { value } = property;
    return (
        value.type !== 'ObjectPattern' &&
        value.type !== 'ArrayPattern' &&
        value.type !== 'RestElement' &&
        value.type !== 'AssignmentPattern'
    );
}

function collectMutatedImportedObjectVariables(
    modules: ReadonlyMap<string, ParsedModuleRecord>,
): Set<eslintScope.Variable> {
    const mutatedVariables = new Set<eslintScope.Variable>();

    for (const record of modules.values()) {
        walkAst(
            record.ast,
            { modules, mutatedVariables, record },
            {
                AssignmentExpression(node, { state }) {
                    markMutatedImportedPattern(node.left, state);
                },
                UpdateExpression(node, { state }) {
                    markMutatedImportedPattern(node.argument, state);
                },
                UnaryExpression(node, { state }) {
                    if (node.operator === 'delete') {
                        markMutatedImportedPattern(node.argument, state);
                    }
                },
                ForInStatement(node, { state }) {
                    markMutatedImportedForIterationTarget(node.left, state);
                },
                ForOfStatement(node, { state }) {
                    markMutatedImportedForIterationTarget(node.left, state);
                },
            },
        );
    }

    return mutatedVariables;
}

function markMutatedImportedForIterationTarget(
    left: Pattern | VariableDeclaration,
    state: ImportedObjectMutationState,
): void {
    if (left.type !== 'VariableDeclaration') {
        markMutatedImportedPattern(left, state);
    }
}

function markMutatedImportedPattern(
    pattern: Pattern | Expression,
    state: ImportedObjectMutationState,
): void {
    if (pattern.type === 'Identifier') {
        markMutatedImportedIdentifier(pattern, state);
        return;
    }

    if (pattern.type === 'MemberExpression') {
        const root = getMemberExpressionRoot(pattern);
        if (root) {
            markMutatedImportedIdentifier(root, state);
        }
        return;
    }

    if (pattern.type === 'ObjectPattern') {
        for (const property of pattern.properties) {
            markMutatedImportedPattern(
                property.type === 'RestElement' ? property.argument : property.value,
                state,
            );
        }
        return;
    }

    if (pattern.type === 'ArrayPattern') {
        for (const element of pattern.elements) {
            if (element) {
                markMutatedImportedPattern(element, state);
            }
        }
        return;
    }

    if (pattern.type === 'RestElement') {
        markMutatedImportedPattern(pattern.argument, state);
        return;
    }

    if (pattern.type === 'AssignmentPattern') {
        markMutatedImportedPattern(pattern.left, state);
    }
}

function markMutatedImportedIdentifier(
    identifier: Identifier,
    state: ImportedObjectMutationState,
): void {
    const variable = resolveImportedObjectAlias(state, identifier, new Set());
    if (variable) {
        state.mutatedVariables.add(variable);
    }
}

function resolveImportedObjectAlias(
    state: ImportedObjectMutationState,
    identifier: Identifier,
    seenVariables: Set<eslintScope.Variable>,
): eslintScope.Variable | undefined {
    const variable = resolveIdentifier(identifier, state.record.scopeAnalysis);
    if (!variable || seenVariables.has(variable)) {
        return undefined;
    }
    seenVariables.add(variable);

    if (isImportVariable(variable)) {
        const definition = resolveStaticDefinitionForIdentifier(
            state.modules,
            state.record.id,
            identifier,
        );
        return definition.kind === 'local' ? definition.variable : undefined;
    }

    const initializer = getVariableInitializer(variable);
    if (!initializer) {
        return undefined;
    }

    const root = getImportedObjectAliasRoot(initializer);
    if (!root) {
        return undefined;
    }

    return resolveImportedObjectAlias(state, root, seenVariables);
}

function getVariableInitializer(variable: eslintScope.Variable): Expression | undefined {
    for (const definition of variable.defs) {
        const node = definition.node as VariableDeclarator;
        if (node.type === 'VariableDeclarator' && node.init) {
            return node.init;
        }
    }

    return undefined;
}

function getImportedObjectAliasRoot(rawExpression: Expression): Identifier | undefined {
    const expression = unwrapStaticExpression(rawExpression);
    if (expression.type === 'Identifier') {
        return expression;
    }
    if (expression.type === 'MemberExpression') {
        return getMemberExpressionRoot(expression);
    }
    return undefined;
}

function getMemberExpressionRoot(node: Expression | Super): Identifier | undefined {
    if (node.type === 'Identifier') {
        return node;
    }
    if (node.type === 'MemberExpression') {
        return getMemberExpressionRoot(node.object);
    }
    return undefined;
}

function getStaticPropertyKey(property: Property): string | undefined {
    if (property.key.type === 'Identifier') {
        return property.key.name;
    }
    if (property.key.type === 'Literal' && typeof property.key.value === 'string') {
        return property.key.value;
    }
    return undefined;
}

function unwrapStaticExpression(expression: Expression): Expression {
    let current = expression;

    while (isTypeScriptExpressionWrapper(current)) {
        current = current.expression;
    }

    return current;
}

function isTypeScriptExpressionWrapper(
    expression: Expression,
): expression is TypeScriptExpressionWrapper & { expression: Expression } {
    const type = (expression as { type: string }).type;
    return (
        (type === 'TSAsExpression' ||
            type === 'TSSatisfiesExpression' ||
            type === 'TSNonNullExpression' ||
            type === 'TSTypeAssertion') &&
        !!(expression as TypeScriptExpressionWrapper).expression
    );
}

function unsupportedAccessorObjectProperty(
    moduleId: string,
    propertyName: string,
): AccessorObjectPropertyStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'accessor-object-property',
        propertyName,
        message: `Static object property '${propertyName}' in module '${moduleId}' is an accessor.`,
    };
}

function unsupportedComputedMemberExpression(
    moduleId: string,
): ComputedMemberExpressionStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'computed-member-expression',
        message: `Computed member expressions in module '${moduleId}' cannot be resolved to static strings.`,
    };
}

function unsupportedComputedObjectProperty(
    moduleId: string,
): ComputedObjectPropertyStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'computed-object-property',
        message: `Computed object properties in module '${moduleId}' cannot be resolved to static strings.`,
    };
}

function unsupportedCycle(moduleId: string, variableName: string): CycleStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'cycle',
        variableName,
        message: `Resolving variable '${variableName}' in module '${moduleId}' would cycle through static string values.`,
    };
}

function unsupportedDuplicateObjectProperty(
    moduleId: string,
    propertyName: string,
): DuplicateObjectPropertyStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'duplicate-object-property',
        propertyName,
        message: `Static object in module '${moduleId}' has duplicate property '${propertyName}'.`,
    };
}

function unsupportedDynamicTemplateLiteral(
    moduleId: string,
): DynamicTemplateLiteralStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'dynamic-template-literal',
        message: `Dynamic template literals in module '${moduleId}' cannot be resolved to static strings.`,
    };
}

function unsupportedImportedObjectMutation(
    moduleId: string,
    variableName: string,
): ImportedObjectMutationStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'imported-object-mutation',
        variableName,
        message: `Imported object '${variableName}' from module '${moduleId}' is mutated in the module graph.`,
    };
}

function unsupportedMissingObjectProperty(
    moduleId: string,
    propertyName: string,
): MissingObjectPropertyStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'missing-object-property',
        propertyName,
        message: `Static object in module '${moduleId}' does not have property '${propertyName}'.`,
    };
}

function unsupportedNonObjectMemberValue(
    moduleId: string,
    expressionType: string,
): NonObjectMemberValueStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'non-object-member-value',
        expressionType,
        message: `Expression type '${expressionType}' in module '${moduleId}' is not a static object value.`,
    };
}

function unsupportedNonStaticMemberProperty(
    moduleId: string,
    propertyType: string,
): NonStaticMemberPropertyStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'non-static-member-property',
        propertyType,
        message: `Member property type '${propertyType}' in module '${moduleId}' is not statically named.`,
    };
}

function unsupportedNonStringLiteral(
    moduleId: string,
    valueType: string,
): NonStringLiteralStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'non-string-literal',
        valueType,
        message: `Literal value type '${valueType}' in module '${moduleId}' is not a string.`,
    };
}

function unsupportedObjectPropertyValue(
    moduleId: string,
    propertyName: string,
    valueType: string,
): UnsupportedObjectPropertyValueStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'unsupported-object-property-value',
        propertyName,
        valueType,
        message: `Static object property '${propertyName}' in module '${moduleId}' has unsupported value type '${valueType}'.`,
    };
}

function unsupportedObjectSpread(moduleId: string): ObjectSpreadStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'object-spread',
        message: `Object spreads in module '${moduleId}' cannot be resolved to static strings.`,
    };
}

function unsupportedOptionalMemberExpression(
    moduleId: string,
): OptionalMemberExpressionStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'optional-member-expression',
        message: `Optional member expressions in module '${moduleId}' cannot be resolved to static strings.`,
    };
}

function unsupportedStaticDefinition(
    definition: UnsupportedStaticDefinition,
    variableName: string,
): StaticDefinitionUnsupportedStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId: definition.moduleId,
        reason: 'static-definition-unsupported',
        variableName,
        definition,
        message: `Variable '${variableName}' could not be resolved to a static definition: ${definition.message}`,
    };
}

function unsupportedUninitializedConst(
    moduleId: string,
    variableName: string,
): UninitializedConstStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'uninitialized-const',
        variableName,
        message: `Const variable '${variableName}' in module '${moduleId}' does not have an initializer.`,
    };
}

function unsupportedExpression(
    moduleId: string,
    expressionType: string,
): UnsupportedExpressionStaticStringValue {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'unsupported-expression',
        expressionType,
        message: `Expression type '${expressionType}' in module '${moduleId}' cannot be resolved to a static string.`,
    };
}
