// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Expression, ObjectExpression, Property, SimpleCallExpression } from 'estree';

import type { ConnectionLabelCallSite } from '../types';

import {
    analyzeActionCatalogScopes,
    findActionCatalogCallSites,
} from './action-catalog-call-sites';
import { collectActionCatalogImports } from './action-catalog-imports';
import type { ParsedModuleRecord } from './module-graph';
import { resolveStaticStringValue } from './static-string-resolution';
import { walkModuleGraph } from './walk-module-graph';

const CONNECTION_ID_PROPERTY = 'connectionId';
const CONNECTION_LABEL_PROPERTY = 'connectionLabel';
const CONNECTION_LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CONNECTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StaticProperty = Property & { value: Expression };

export interface ExtractedConnections {
    connectionIds: string[];
    /** Each static `connectionLabel` with the same call's literal `connectionId`, deduplicated by pair. */
    connectionLabels: ConnectionLabelCallSite[];
}

type CallSiteVisitor = (callSite: SimpleCallExpression, record: ParsedModuleRecord) => void;

/**
 * Extracts the conservative backend-file connection ID union from module records
 * collected while the backend bundler walked the real execution graph. Rejects
 * the same labels a build does, so the dev server catches them first.
 */
export function extractConnectionIdsFromModuleGraph(
    entryId: string,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    buildRoot: string,
): string[] {
    return extractConnectionsFromModuleGraph(entryId, modules, buildRoot).connectionIds;
}

/** Extracts the connection IDs and the connection labels in a single walk. */
export function extractConnectionsFromModuleGraph(
    entryId: string,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    buildRoot: string,
): ExtractedConnections {
    const connectionIds = new Set<string>();
    const connectionLabels = new Map<string, ConnectionLabelCallSite>();

    forEachActionCatalogCallSite(entryId, modules, buildRoot, (callSite, record) => {
        const connectionId = extractConnectionId(callSite, modules, record);
        if (connectionId !== undefined) {
            connectionIds.add(connectionId);
        }
        const label = extractConnectionLabel(callSite, modules, record);
        if (label === undefined) {
            return;
        }
        // Upload rejects a fallback that isn't a connection ID, so fail here at the call site.
        if (connectionId !== undefined && !CONNECTION_ID_PATTERN.test(connectionId)) {
            throw unsupportedConnectionLabel(
                record.id,
                `the fallback connectionId "${connectionId}" for "${label}" must be a connection ID (a UUID)`,
            );
        }
        const labelCallSite = {
            label,
            ...(connectionId === undefined ? {} : { fallbackConnectionId: connectionId }),
        };
        const labelCallSiteKey = JSON.stringify([label, connectionId ?? null]);
        connectionLabels.set(labelCallSiteKey, labelCallSite);
    });

    const sortedLabels = [...connectionLabels.values()].sort(
        (a, b) =>
            compareCodeUnits(a.label, b.label) ||
            compareCodeUnits(a.fallbackConnectionId ?? '', b.fallbackConnectionId ?? ''),
    );
    return { connectionIds: [...connectionIds].sort(), connectionLabels: sortedLabels };
}

// Walk the already-parsed records from this backend entry's build. The
// extraction cost is linear in reachable app-local modules, without
// reparsing source files here.
function forEachActionCatalogCallSite(
    entryId: string,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    buildRoot: string,
    visit: CallSiteVisitor,
): void {
    walkModuleGraph(entryId, modules, buildRoot, ({ record }) => {
        const imports = collectActionCatalogImports(record.ast);
        const scopeAnalysis = analyzeActionCatalogScopes(record.scopeAnalysis, imports);
        const callSites = findActionCatalogCallSites(record.ast, scopeAnalysis, record.id);
        for (const callSite of callSites) {
            visit(callSite, record);
        }
    });
}

// `''` is a valid declared connectionId, not "none" — only the absence of a
// `connectionId` property (`undefined`) means no restriction to record.
function extractConnectionId(
    callSite: SimpleCallExpression,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    record: ParsedModuleRecord,
): string | undefined {
    const value = extractStaticStringFromActionCall(
        callSite,
        modules,
        record,
        CONNECTION_ID_PROPERTY,
    );
    if (value.kind === 'resolved') {
        return value.value;
    }
    if (value.kind === 'absent') {
        return undefined;
    }
    throw unsupportedConnectionId(record.id, value.reason);
}

function extractConnectionLabel(
    callSite: SimpleCallExpression,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    record: ParsedModuleRecord,
): string | undefined {
    const value = extractStaticStringFromActionCall(
        callSite,
        modules,
        record,
        CONNECTION_LABEL_PROPERTY,
    );
    if (value.kind === 'absent') {
        return undefined;
    }
    if (value.kind === 'unsupported') {
        throw unsupportedConnectionLabel(record.id, value.reason);
    }
    if (!CONNECTION_LABEL_PATTERN.test(value.value)) {
        throw unsupportedConnectionLabel(
            record.id,
            `"${value.value}" must match ${CONNECTION_LABEL_PATTERN}`,
        );
    }
    return value.value;
}

// Code-unit order, as `[].sort()` uses, so the manifest is the same on every machine.
function compareCodeUnits(a: string, b: string): number {
    if (a < b) {
        return -1;
    }
    if (a > b) {
        return 1;
    }
    return 0;
}

type StaticStringProperty =
    | { kind: 'absent' }
    | { kind: 'resolved'; value: string }
    | { kind: 'unsupported'; reason: string };

function extractStaticStringFromActionCall(
    node: SimpleCallExpression,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    record: ParsedModuleRecord,
    propertyName: string,
): StaticStringProperty {
    const [firstArg] = node.arguments;
    if (!firstArg || firstArg.type !== 'ObjectExpression') {
        throw unsupportedActionCatalogCall(
            record.id,
            'non-object action-catalog call arguments',
            propertyName,
        );
    }

    const property = findStaticProperty(firstArg, record.id, propertyName);
    if (!property) {
        return { kind: 'absent' };
    }

    const result = resolveStaticStringValue(modules, record.id, property.value);
    if (result.kind === 'resolved') {
        return { kind: 'resolved', value: result.value };
    }

    const unsupportedReason = getStaticStringUnsupportedReason(result);
    return {
        kind: 'unsupported',
        reason: `static string resolution ${unsupportedReason}: ${result.message}`,
    };
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
 * Finds the `propertyName` property in an action-catalog call's options object.
 *
 * This rejects spreads, computed keys, duplicate keys, and accessor properties
 * because those shapes can hide or change the actual value.
 */
function findStaticProperty(
    objectExpression: ObjectExpression,
    filePath: string,
    propertyName: string,
): StaticProperty | undefined {
    let staticProperty: StaticProperty | undefined;
    for (const property of objectExpression.properties) {
        if (property.type === 'SpreadElement') {
            throw unsupportedActionCatalogCall(filePath, 'spread object arguments', propertyName);
        }
        if (property.computed) {
            throw unsupportedActionCatalogCall(
                filePath,
                'computed object property keys',
                propertyName,
            );
        }
        if (getStaticPropertyKey(property) === propertyName) {
            if (staticProperty) {
                throw unsupportedActionCatalogCall(
                    filePath,
                    `multiple ${propertyName} properties`,
                    propertyName,
                );
            }
            if (property.kind !== 'init') {
                throw unsupportedActionCatalogCall(
                    filePath,
                    `accessor ${propertyName} properties`,
                    propertyName,
                );
            }
            if (!hasExpressionValue(property)) {
                throw unsupportedActionCatalogCall(
                    filePath,
                    `destructuring pattern in ${propertyName} value`,
                    propertyName,
                );
            }
            staticProperty = property;
        }
    }
    return staticProperty;
}

function hasExpressionValue(property: Property): property is StaticProperty {
    const { value } = property;
    return (
        value.type !== 'ObjectPattern' &&
        value.type !== 'ArrayPattern' &&
        value.type !== 'RestElement' &&
        value.type !== 'AssignmentPattern'
    );
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

function unsupportedActionCatalogCall(
    filePath: string,
    unsupported: string,
    propertyName: string,
): Error {
    return new Error(
        `Unsupported action-catalog call in ${filePath}: ${unsupported} could hide a ${propertyName}.`,
    );
}

function unsupportedConnectionId(filePath: string, unsupported: string): Error {
    return new Error(`Unsupported action-catalog connectionId in ${filePath}: ${unsupported}.`);
}

function unsupportedConnectionLabel(filePath: string, unsupported: string): Error {
    return new Error(`Unsupported action-catalog connectionLabel in ${filePath}: ${unsupported}.`);
}
