// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type * as t from '@babel/types';
import path from 'path';

import type { BabelPath, BabelTypesModule } from './babel-path.types';

/**
 * Generate a stable, unique function ID
 * Format (POC): <relative-file-path>;<function-name>
 * Example: src/utils.js;add
 *
 * NOTE: This POC format only supports uniquely named functions.
 * Anonymous functions will use the format <file-path>;<anonymous>:<index>
 */
export function generateFunctionId(
    filePath: string,
    buildRoot: string,
    functionPath: BabelPath<t.Function>,
    anonymousSiblingIndex: number,
    typesModule: BabelTypesModule,
): string {
    const relativePath = path.relative(buildRoot, filePath).replace(/\\/g, '/');
    const functionName = getFunctionName(functionPath, typesModule);

    if (functionName) {
        return `${relativePath};${functionName}`;
    }

    const locationSuffix = getFunctionLocation(functionPath);

    return `${relativePath};<anonymous>@${locationSuffix}:${anonymousSiblingIndex}`;
}

/**
 * Get the name of a function if available
 */
export function getFunctionName(
    functionPath: BabelPath<t.Function>,
    typesModule: BabelTypesModule,
): string | null {
    const node = functionPath.node;
    const parent = functionPath.parent;

    // Named function declaration: function foo() {}
    if ('id' in node && typesModule.isIdentifier(node.id)) {
        return node.id.name;
    }

    // Object/Class method: { foo() {} } or class { foo() {} }
    if (
        typesModule.isObjectMethod(node) ||
        typesModule.isClassMethod(node) ||
        typesModule.isClassPrivateMethod(node)
    ) {
        return getPropertyLikeName(node.key, typesModule);
    }

    // Variable declaration: const foo = () => {}
    if (typesModule.isVariableDeclarator(parent) && typesModule.isIdentifier(parent.id)) {
        return parent.id.name;
    }

    // Assignment: foo = () => {} or obj.foo = () => {}
    if (typesModule.isAssignmentExpression(parent)) {
        return getAssignmentTargetName(parent.left, typesModule);
    }

    // Object property: { foo: () => {} }
    if (
        typesModule.isObjectProperty(parent) ||
        typesModule.isClassProperty(parent) ||
        typesModule.isClassPrivateProperty(parent)
    ) {
        return getPropertyLikeName(parent.key, typesModule);
    }

    return null;
}

function getAssignmentTargetName(
    target: t.LVal | t.OptionalMemberExpression,
    typesModule: BabelTypesModule,
): string | null {
    if (typesModule.isIdentifier(target)) {
        return target.name;
    }

    if (typesModule.isMemberExpression(target) || typesModule.isOptionalMemberExpression(target)) {
        const objectName = getMemberObjectName(target.object, typesModule);
        const propertyName = getMemberPropertyName(target.property, target.computed, typesModule);

        if (objectName && propertyName) {
            return `${objectName}.${propertyName}`;
        }
    }

    return null;
}

function getMemberObjectName(
    target: t.Expression | t.Super,
    typesModule: BabelTypesModule,
): string | null {
    if (typesModule.isIdentifier(target)) {
        return target.name;
    }

    if (typesModule.isThisExpression(target)) {
        return 'this';
    }

    if (typesModule.isMemberExpression(target) || typesModule.isOptionalMemberExpression(target)) {
        const parentObjectName = getMemberObjectName(target.object, typesModule);
        const propertyName = getMemberPropertyName(target.property, target.computed, typesModule);

        if (parentObjectName && propertyName) {
            return `${parentObjectName}.${propertyName}`;
        }
    }

    return null;
}

function getMemberPropertyName(
    property: t.Expression | t.PrivateName,
    isComputed: boolean,
    typesModule: BabelTypesModule,
): string | null {
    if (typesModule.isPrivateName(property) && typesModule.isIdentifier(property.id)) {
        return `#${property.id.name}`;
    }

    if (isComputed) {
        return null;
    }

    if (typesModule.isIdentifier(property)) {
        return property.name;
    }

    return null;
}

function getPropertyLikeName(
    key: t.Expression | t.PrivateName | t.Identifier,
    typesModule: BabelTypesModule,
): string | null {
    if (typesModule.isIdentifier(key)) {
        return key.name;
    }

    if (
        typesModule.isStringLiteral(key) ||
        typesModule.isNumericLiteral(key) ||
        typesModule.isBigIntLiteral(key)
    ) {
        return String(key.value);
    }

    if (typesModule.isPrivateName(key) && typesModule.isIdentifier(key.id)) {
        return `#${key.id.name}`;
    }

    return null;
}

function getFunctionLocation(functionPath: BabelPath<t.Function>): string {
    const line = functionPath.node.loc?.start.line ?? 0;
    const column = functionPath.node.loc?.start.column ?? 0;

    return `${line}:${column}`;
}
