// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as t from '@babel/types';
import path from 'path';

import type { BabelPath } from './babel-path.types';

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
): string {
    const relativePath = path.relative(buildRoot, filePath).replace(/\\/g, '/');
    const functionName = getFunctionName(functionPath);

    if (functionName) {
        return `${relativePath};${functionName}`;
    }

    const locationSuffix = getFunctionLocation(functionPath);

    return `${relativePath};<anonymous>@${locationSuffix}:${anonymousSiblingIndex}`;
}

/**
 * Get the name of a function if available
 */
export function getFunctionName(functionPath: BabelPath<t.Function>): string | null {
    const node = functionPath.node;
    const parent = functionPath.parent;

    // Named function declaration: function foo() {}
    if ('id' in node && t.isIdentifier(node.id)) {
        return node.id.name;
    }

    // Object/Class method: { foo() {} } or class { foo() {} }
    if (t.isObjectMethod(node) || t.isClassMethod(node) || t.isClassPrivateMethod(node)) {
        return getPropertyLikeName(node.key);
    }

    // Variable declaration: const foo = () => {}
    if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
        return parent.id.name;
    }

    // Assignment: foo = () => {} or obj.foo = () => {}
    if (t.isAssignmentExpression(parent)) {
        return getAssignmentTargetName(parent.left);
    }

    // Object property: { foo: () => {} }
    if (
        t.isObjectProperty(parent) ||
        t.isClassProperty(parent) ||
        t.isClassPrivateProperty(parent)
    ) {
        return getPropertyLikeName(parent.key);
    }

    return null;
}

function getAssignmentTargetName(target: t.LVal | t.OptionalMemberExpression): string | null {
    if (t.isIdentifier(target)) {
        return target.name;
    }

    if (t.isMemberExpression(target) || t.isOptionalMemberExpression(target)) {
        const objectName = getMemberObjectName(target.object);
        const propertyName = getMemberPropertyName(target.property, target.computed);

        if (objectName && propertyName) {
            return `${objectName}.${propertyName}`;
        }
    }

    return null;
}

function getMemberObjectName(target: t.Expression | t.Super): string | null {
    if (t.isIdentifier(target)) {
        return target.name;
    }

    if (t.isThisExpression(target)) {
        return 'this';
    }

    if (t.isMemberExpression(target) || t.isOptionalMemberExpression(target)) {
        const parentObjectName = getMemberObjectName(target.object);
        const propertyName = getMemberPropertyName(target.property, target.computed);

        if (parentObjectName && propertyName) {
            return `${parentObjectName}.${propertyName}`;
        }
    }

    return null;
}

function getMemberPropertyName(
    property: t.Expression | t.PrivateName,
    isComputed: boolean,
): string | null {
    if (t.isPrivateName(property) && t.isIdentifier(property.id)) {
        return `#${property.id.name}`;
    }

    if (isComputed) {
        return null;
    }

    if (t.isIdentifier(property)) {
        return property.name;
    }

    return null;
}

function getPropertyLikeName(key: t.Expression | t.PrivateName | t.Identifier): string | null {
    if (t.isIdentifier(key)) {
        return key.name;
    }

    if (t.isStringLiteral(key) || t.isNumericLiteral(key) || t.isBigIntLiteral(key)) {
        return String(key.value);
    }

    if (t.isPrivateName(key) && t.isIdentifier(key.id)) {
        return `#${key.id.name}`;
    }

    return null;
}

function getFunctionLocation(functionPath: BabelPath<t.Function>): string {
    const line = functionPath.node.loc?.start.line ?? 0;
    const column = functionPath.node.loc?.start.column ?? 0;

    return `${line}:${column}`;
}
