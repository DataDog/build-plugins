// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as t from '@babel/types';

import type { BabelPath } from './babel-path.types';

function hasSkipComment(path: BabelPath, skipComment: string): boolean {
    if (path.node.leadingComments) {
        for (const comment of path.node.leadingComments) {
            if (comment.value.includes(skipComment)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Check if a function should be skipped based on comments.
 *
 * Walks up the AST from the function node through wrapping expression/declaration
 * nodes (VariableDeclarator, VariableDeclaration, ExportNamedDeclaration, etc.)
 * and checks leadingComments at each level. Stops at statement-level boundaries
 * so that comments on unrelated statements are never matched.
 *
 * After reaching a statement boundary (e.g. VariableDeclaration), also checks the
 * parent if it is an export declaration, because `export const fn = ...` attaches
 * the comment to the ExportNamedDeclaration, one level above the statement.
 */
export function shouldSkipFunction(
    functionPath: BabelPath<t.Function>,
    skipComment: string,
): boolean {
    let current: BabelPath | null = functionPath;

    while (current) {
        if (hasSkipComment(current, skipComment)) {
            return true;
        }

        // Stop once we reach a statement or export declaration — that is the
        // outermost node where Babel would attach a line-level leading comment.
        if (t.isStatement(current.node) || t.isExportDeclaration(current.node)) {
            // For `export const fn = ...`, the comment is on the ExportDeclaration
            // which wraps the VariableDeclaration statement.
            if (current.parentPath && t.isExportDeclaration(current.parentPath.node)) {
                return hasSkipComment(current.parentPath, skipComment);
            }
            break;
        }

        current = current.parentPath;
    }

    return false;
}

/**
 * Check if function should be instrumented
 * Skips: generators and constructors
 */
export function canInstrumentFunction(functionPath: BabelPath<t.Function>): boolean {
    const node = functionPath.node;

    // Skip generators
    if (node.generator) {
        return false;
    }

    // Skip constructors
    if (t.isClassMethod(node) && node.kind === 'constructor') {
        return false;
    }

    return true;
}
