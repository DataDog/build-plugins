// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Expression, ObjectExpression, Property, SimpleCallExpression } from 'estree';

import {
    analyzeActionCatalogScopes,
    findActionCatalogCallSites,
} from './action-catalog-call-sites';
import { collectActionCatalogImports } from './action-catalog-imports';
import type { ParsedModuleRecord } from './module-graph';
import { resolveStaticStringValue } from './static-string-resolution';
import { walkModuleGraph } from './walk-module-graph';

const CONNECTION_ID_PROPERTY = 'connectionId';

type ConnectionIdProperty = Property & { value: Expression };

/**
 * Extracts the conservative backend-file connection ID union from module records
 * collected while the backend bundler walked the real execution graph.
 */
export function extractConnectionIdsFromModuleGraph(
    entryId: string,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    buildRoot: string,
): string[] {
    const connectionIds = new Set<string>();

    // Walk the already-parsed records from this backend entry's build. The
    // extraction cost is linear in reachable app-local modules, without
    // reparsing source files here.
    walkModuleGraph(entryId, modules, buildRoot, ({ record }) => {
        const imports = collectActionCatalogImports(record.ast);
        const scopeAnalysis = analyzeActionCatalogScopes(record.scopeAnalysis, imports);

        for (const callSite of findActionCatalogCallSites(record.ast, scopeAnalysis, record.id)) {
            const connectionId = extractConnectionIdFromActionCall(callSite, modules, record);
            if (connectionId) {
                connectionIds.add(connectionId);
            }
        }
    });

    return [...connectionIds].sort();
}

function extractConnectionIdFromActionCall(
    node: SimpleCallExpression,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    record: ParsedModuleRecord,
): string | undefined {
    const [firstArg] = node.arguments;
    if (!firstArg || firstArg.type !== 'ObjectExpression') {
        throw unsupportedActionCatalogCall(record.id, 'non-object action-catalog call arguments');
    }

    const connectionIdProperty = findConnectionIdProperty(firstArg, record.id);
    if (!connectionIdProperty) {
        return undefined;
    }

    const result = resolveStaticStringValue(modules, record.id, connectionIdProperty.value);
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
