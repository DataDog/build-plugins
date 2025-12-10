// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// @ts-nocheck - Babel type conflicts between @babel/parser and @babel/types versions
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

export interface ScopeVariables {
    params: string[];
    locals: string[];
}

/**
 * Extract all variables in scope for a function
 * This includes parameters and local variable declarations
 */
export function extractScopeVariables(functionPath: NodePath<t.Function>): ScopeVariables {
    const params: string[] = [];
    const locals: string[] = [];

    // Extract parameters
    functionPath.node.params.forEach((param) => {
        if (t.isIdentifier(param)) {
            params.push(param.name);
        } else if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
            params.push(param.argument.name);
        } else if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
            params.push(param.left.name);
        }
        // Note: destructuring patterns are more complex and we'll skip them for now
    });

    // Extract local variables from bindings
    const bindings = functionPath.scope.bindings;
    Object.keys(bindings).forEach((name) => {
        const binding = bindings[name];
        // Skip parameters (already added) and skip function name itself
        if (
            !params.includes(name) &&
            name !== (t.isIdentifier(functionPath.node.id) ? functionPath.node.id.name : '')
        ) {
            // Only include var/let/const declarations
            if (['var', 'let', 'const'].includes(binding.kind)) {
                locals.push(name);
            }
        }
    });

    return { params, locals };
}

/**
 * Build an object expression capturing the specified variables
 * Returns: { a, b, c } as an AST node
 */
export function buildVariableCaptureExpression(variables: string[]): t.ObjectExpression {
    return t.objectExpression(
        variables.map((name) =>
            t.objectProperty(t.identifier(name), t.identifier(name), false, true),
        ),
    );
}

/**
 * Get all variables that should be captured at a specific point
 * (for use at function entry, return, or throw)
 */
export function getVariablesToCapture(
    functionPath: NodePath<t.Function>,
    includeParams: boolean = true,
    includeLocals: boolean = true,
): string[] {
    const { params, locals } = extractScopeVariables(functionPath);
    const variables: string[] = [];

    if (includeParams) {
        variables.push(...params);
    }
    if (includeLocals) {
        variables.push(...locals);
    }

    return variables;
}
