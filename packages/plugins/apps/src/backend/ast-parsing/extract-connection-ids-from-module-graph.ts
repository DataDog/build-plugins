// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type * as eslintScope from 'eslint-scope';
import type { Expression, ObjectExpression, Property, SimpleCallExpression } from 'estree';

import {
    analyzeActionCatalogScopes,
    findActionCatalogCallSites,
} from './action-catalog-call-sites';
import { collectActionCatalogImports } from './action-catalog-imports';
import type { ParsedModuleRecord } from './module-graph';
import {
    collectMutatedImportedObjectVariables,
    resolveStaticStringValue,
} from './static-string-resolution';
import { walkModuleGraph } from './walk-module-graph';

const CONNECTION_ID_PROPERTY = 'connectionId';
// `__proto__` can supply a connectionId from a prototype, and toJSON or then can replace the
// options when they are serialized or awaited.
const OPTION_HOOK_KEYS: ReadonlySet<string> = new Set(['__proto__', 'toJSON', 'then']);

type ConnectionIdProperty = Property & { value: Expression };

export interface ActionCatalogCall {
    record: ParsedModuleRecord;
    callSite: SimpleCallExpression;
    connectionId: string | undefined;
}

/**
 * Extracts the conservative backend-file connection ID union from module records
 * collected while the backend bundler walked the real execution graph.
 */
export function extractConnectionIdsFromModuleGraph(
    entryId: string,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    buildRoot: string,
): string[] {
    const calls = collectActionCatalogCalls(entryId, modules, buildRoot);
    return getConnectionIds(calls);
}

export function getConnectionIds(calls: ActionCatalogCall[]): string[] {
    const connectionIds = new Set<string>();

    for (const { connectionId } of calls) {
        // `''` is a valid declared connectionId, not "none" — only the absence of a
        // `connectionId` property (`undefined`) means no restriction to record.
        if (connectionId !== undefined) {
            connectionIds.add(connectionId);
        }
    }

    return [...connectionIds].sort();
}

export function collectActionCatalogCalls(
    entryId: string,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    buildRoot: string,
): ActionCatalogCall[] {
    const calls: ActionCatalogCall[] = [];
    let mutatedImportedObjectVariables: Set<eslintScope.Variable> | undefined;
    const getMutatedImportedObjectVariables = () => {
        mutatedImportedObjectVariables ??= collectMutatedImportedObjectVariables(modules);
        return mutatedImportedObjectVariables;
    };

    // Walk the already-parsed records from this backend entry's build. The
    // extraction cost is linear in reachable app-local modules, without
    // reparsing source files here.
    walkModuleGraph(entryId, modules, buildRoot, ({ record }) => {
        const imports = collectActionCatalogImports(record.ast);
        const scopeAnalysis = analyzeActionCatalogScopes(record.scopeAnalysis, imports);

        for (const callSite of findActionCatalogCallSites(record.ast, scopeAnalysis, record.id)) {
            const connectionId = extractConnectionIdFromActionCall(
                callSite,
                modules,
                record,
                getMutatedImportedObjectVariables,
            );
            calls.push({ record, callSite, connectionId });
        }
    });

    return calls;
}

function extractConnectionIdFromActionCall(
    node: SimpleCallExpression,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    record: ParsedModuleRecord,
    getMutatedImportedObjectVariables: () => ReadonlySet<eslintScope.Variable>,
): string | undefined {
    const [firstArg] = node.arguments;
    if (!firstArg || firstArg.type !== 'ObjectExpression') {
        throw unsupportedActionCatalogCall(record.id, 'non-object action-catalog call arguments');
    }

    const connectionIdProperty = findConnectionIdProperty(firstArg, record.id);
    if (!connectionIdProperty) {
        return undefined;
    }

    const mutatedImportedObjectVariables = getMutatedImportedObjectVariables();
    const result = resolveStaticStringValue(
        modules,
        record.id,
        connectionIdProperty.value,
        mutatedImportedObjectVariables,
    );
    if (result.kind === 'resolved') {
        return result.value;
    }

    throw unsupportedConnectionId(
        record.id,
        `static string resolution ${getStaticStringUnsupportedReason(result)}: ${result.message}`,
    );
}

function getStaticStringUnsupportedReason(
    result: Exclude<ReturnType<typeof resolveStaticStringValue>, { kind: 'resolved' }>,
): string {
    if (result.reason === 'static-definition-unsupported') {
        return `${result.reason}/${result.definition.reason}`;
    }

    return result.reason;
}

/**
 * Finds the `connectionId` property in an action-catalog call's options object.
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
        const key = getStaticPropertyKey(property);
        if (key !== undefined && OPTION_HOOK_KEYS.has(key) && !isInertProtoKey(key, property)) {
            throw unsupportedActionCatalogCall(filePath, `a "${key}" property`);
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

// A shorthand `__proto__` is an own property, and a null prototype supplies nothing.
function isInertProtoKey(key: string, property: Property): boolean {
    const { value } = property;
    return (
        key === '__proto__' &&
        (property.shorthand || (value.type === 'Literal' && value.value === null))
    );
}

function isConnectionIdKey(property: Property): boolean {
    return getStaticPropertyKey(property) === CONNECTION_ID_PROPERTY;
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

function unsupportedActionCatalogCall(filePath: string, unsupported: string): Error {
    return new Error(
        `Unsupported action-catalog call in ${filePath}: ${unsupported} could hide a connectionId.`,
    );
}

function unsupportedConnectionId(filePath: string, unsupported: string): Error {
    return new Error(`Unsupported action-catalog connectionId in ${filePath}: ${unsupported}.`);
}
