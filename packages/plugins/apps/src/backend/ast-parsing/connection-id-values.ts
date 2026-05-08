// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { ObjectExpression, Property, SimpleCallExpression } from 'estree';

const CONNECTION_ID_PROPERTY = 'connectionId';

export function extractConnectionIdFromActionCall(
    node: SimpleCallExpression,
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

    const { value } = connectionIdProperty;
    if (value.type === 'Literal' && typeof value.value === 'string') {
        return value.value;
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
