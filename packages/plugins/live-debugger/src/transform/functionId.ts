// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// @ts-nocheck - Babel type conflicts between @babel/parser and @babel/types versions
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import path from 'path';

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
    functionPath: NodePath<t.Function>,
): string {
    const relativePath = path.relative(buildRoot, filePath).replace(/\\/g, '/');
    const functionName = getFunctionName(functionPath);

    if (functionName) {
        // Named function: file.js;functionName
        return `${relativePath};${functionName}`;
    } else {
        // Anonymous function: file.js;<anonymous>:index
        const index = countPreviousAnonymousSiblings(functionPath);
        return `${relativePath};<anonymous>:${index}`;
    }
}

/**
 * Get the name of a function if available
 */
function getFunctionName(functionPath: NodePath<t.Function>): string | null {
    const node = functionPath.node;
    const parent = functionPath.parent;

    // Named function declaration: function foo() {}
    if (t.isIdentifier(node.id)) {
        return node.id.name;
    }

    // Object/Class method: { foo() {} } or class { foo() {} }
    if ((t.isObjectMethod(node) || t.isClassMethod(node)) && t.isIdentifier(node.key)) {
        return node.key.name;
    }

    // Variable declaration: const foo = () => {}
    if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
        return parent.id.name;
    }

    // Assignment: foo = () => {}
    if (t.isAssignmentExpression(parent) && t.isIdentifier(parent.left)) {
        return parent.left.name;
    }

    // Object property: { foo: () => {} }
    if (t.isObjectProperty(parent) && t.isIdentifier(parent.key)) {
        return parent.key.name;
    }

    return null;
}

/**
 * Count anonymous functions before this one at the same parent level
 */
function countPreviousAnonymousSiblings(functionPath: NodePath<t.Function>): number {
    const parent = functionPath.parentPath;
    if (!parent) {
        return 0;
    }

    let count = 0;
    const targetNode = functionPath.node;

    // Find all function children of the parent
    parent.traverse({
        Function(fnPath: NodePath<t.Function>) {
            // Don't traverse into nested functions
            if (fnPath.parentPath !== parent) {
                fnPath.skip();
                return;
            }

            // Stop when we reach our target function
            if (fnPath.node === targetNode) {
                fnPath.stop();
                return;
            }

            // Count if it's anonymous
            if (!getFunctionName(fnPath)) {
                count++;
            }
        },
    });

    return count;
}
