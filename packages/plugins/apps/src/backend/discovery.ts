// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Declaration, Expression, Program } from 'estree';
import type { AstNode } from 'rollup';

export interface BackendFunction {
    /** Relative path from project root to the .backend.ts file (without extension) */
    path: string;
    /** Exported function name */
    name: string;
    /** Absolute path to the .backend.ts source file */
    entryPath: string;
}

/**
 * Extract exported value (non-type) symbols from an ESTree AST.
 * Expects plain JavaScript — TypeScript types must already be stripped
 * (e.g. by Vite's built-in esbuild transform that runs before our hook).
 *
 * Throws on invalid exports (e.g. default exports) and unexpected AST shapes.
 * Returns an empty array when the file has no named exports.
 *
 * @param ast - AstNode from `this.parse()` in unplugin's transform hook
 * @param filePath - Path to the source file (used in error messages)
 */
function isProgramNode(node: AstNode): node is AstNode & Program {
    return node.type === 'Program';
}

export function extractExportedFunctions(ast: AstNode, filePath: string): string[] {
    if (!isProgramNode(ast)) {
        throw new Error(
            `Expected a Program node from this.parse() for ${filePath}, got ${ast.type}`,
        );
    }
    const names: string[] = [];
    for (const node of ast.body) {
        // handles: export default ...
        if (node.type === 'ExportDefaultDeclaration') {
            throw new Error(
                `Default exports are not supported in .backend.ts files. Use a named export instead: ${filePath}`,
            );
        }
        if (node.type !== 'ExportNamedDeclaration') {
            continue;
        }

        // handles: export function add() {} / export const add = ...
        if (node.declaration) {
            names.push(...namesFromDeclaration(node.declaration, filePath));
        }

        for (const spec of node.specifiers) {
            if (spec.exported.type !== 'Identifier') {
                continue;
            }
            // handles: export { add as default }
            if (spec.exported.name === 'default') {
                throw new Error(
                    `Default exports are not supported in .backend.ts files. Use a named export instead: ${filePath}`,
                );
            }
            // handles: export { add, multiply }
            names.push(spec.exported.name);
        }
    }
    return names;
}

/** Init types that are definitively non-callable at runtime. */
const NON_CALLABLE_INIT_TYPES = new Set([
    'ArrayExpression',
    'Literal',
    'ObjectExpression',
    'TemplateLiteral',
]);

/**
 * Return `true` when the initializer is known to be non-callable.
 * `ArrowFunctionExpression` / `FunctionExpression` are clearly callable.
 * Ambiguous forms (`Identifier`, `CallExpression`, …) are allowed — the
 * user may legitimately re-export an imported function or a factory result.
 */
function isNonCallableInit(init: Expression | null | undefined): boolean {
    return init === null || init === undefined || NON_CALLABLE_INIT_TYPES.has(init.type);
}

/**
 * Extract identifier names from an exported declaration node.
 * Handles `export function foo()` and `export const foo = ...` forms.
 * Throws when a variable export has a non-callable initializer.
 */
function namesFromDeclaration(decl: Declaration, filePath: string): string[] {
    if (decl.type === 'FunctionDeclaration' && decl.id) {
        return [decl.id.name];
    }
    if (decl.type === 'VariableDeclaration') {
        return decl.declarations.flatMap((d) => {
            if (d.id.type !== 'Identifier') {
                return [];
            }
            if (isNonCallableInit(d.init)) {
                throw new Error(
                    `Non-function export "${d.id.name}" in backend file ${filePath}. Only function exports are supported — use "export function ${d.id.name}(…) { }" instead.`,
                );
            }
            return [d.id.name];
        });
    }
    return [];
}
