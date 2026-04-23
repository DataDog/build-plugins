// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Declaration, Expression, Program } from 'estree';
import type { AstNode } from 'rollup';

export interface BackendFunction {
    /** Relative path from project root to the .backend.ts file (without extension) */
    relativePath: string;
    /** Exported function name */
    name: string;
    /** Absolute path to the .backend.ts source file */
    absolutePath: string;
    /** Connection IDs statically extracted from `request({ connectionId })` call sites. */
    allowedConnectionIds: string[];
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

    // Build a map of top-level declarations so we can validate export specifiers.
    const declarations = buildDeclarationMap(ast);

    const names: string[] = [];
    for (const node of ast.body) {
        // handles: export default ...
        if (node.type === 'ExportDefaultDeclaration') {
            throw new Error(
                `Default exports are not supported in .backend.ts files. Use a named export instead: ${filePath}`,
            );
        }
        // handles: export * from '...'
        if (node.type === 'ExportAllDeclaration') {
            throw new Error(
                `"export *" is not supported in .backend.ts files. Use explicit named exports instead: ${filePath}`,
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
            // Validate specifier binding is callable when we can resolve it.
            // e.g. `const VERSION = '1.0'; export { VERSION };` — rejected
            // e.g. `function add() {}; export { add };` — allowed
            if (spec.local.type === 'Identifier') {
                validateSpecifierBinding(spec.local.name, declarations, filePath);
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
    // export function add(a, b) { return a + b; }
    if (decl.type === 'FunctionDeclaration' && decl.id) {
        return [decl.id.name];
    }
    // export class MyClass {} — classes are not callable as RPC endpoints
    if (decl.type === 'ClassDeclaration') {
        throw new Error(
            `Class exports are not supported in .backend.ts files. Only function exports are allowed: ${filePath}`,
        );
    }
    if (decl.type === 'VariableDeclaration') {
        return decl.declarations.flatMap((d) => {
            // export const { a, b } = obj;
            // export const [a, b] = arr;
            if (d.id.type !== 'Identifier') {
                throw new Error(
                    `Destructured exports are not supported in backend files. Use individual named exports instead: ${filePath}`,
                );
            }
            // export const VERSION = '1.0';  — non-callable, throws
            // export const config = { ... }; — non-callable, throws
            if (isNonCallableInit(d.init)) {
                throw new Error(
                    `Non-function export "${d.id.name}" in backend file ${filePath}. Only function exports are supported — use "export function ${d.id.name}(…) { }" instead.`,
                );
            }
            // export const add = (a, b) => a + b;
            // export const handler = importedFn;  — ambiguous, allowed
            return [d.id.name];
        });
    }
    throw new Error(
        `Unsupported export declaration type "${decl.type}" in backend file ${filePath}. Only function and variable exports are allowed.`,
    );
}

/**
 * Describes a top-level declaration for specifier validation.
 * 'function' and 'import' are always allowed (callable or ambiguous).
 * 'class' is rejected.  'variable' is checked via its initializer.
 */
type DeclInfo =
    | { kind: 'function' | 'import' | 'class' }
    | { kind: 'variable'; init: Expression | null | undefined };

/**
 * Build a map from identifier name → declaration info for all top-level
 * statements.  Used to validate `export { name }` specifiers.
 */
function buildDeclarationMap(ast: Program): Map<string, DeclInfo> {
    const map = new Map<string, DeclInfo>();
    for (const node of ast.body) {
        if (node.type === 'FunctionDeclaration' && node.id) {
            // handles: function add(a, b) { return a + b; }
            map.set(node.id.name, { kind: 'function' });
        } else if (node.type === 'ClassDeclaration' && node.id) {
            // handles: class MyService {}
            map.set(node.id.name, { kind: 'class' });
        } else if (node.type === 'VariableDeclaration') {
            // handles: const add = (a, b) => a + b;  /  const VERSION = '1.0';
            for (const d of node.declarations) {
                if (d.id.type === 'Identifier') {
                    map.set(d.id.name, { kind: 'variable', init: d.init });
                }
            }
        } else if (node.type === 'ImportDeclaration') {
            // handles: import { handler } from './other';
            // For this case, we allow exporting handler and accept that it may not be a function.
            for (const spec of node.specifiers) {
                map.set(spec.local.name, { kind: 'import' });
            }
        }
    }
    return map;
}

/**
 * Validate that an export specifier's local binding is callable.
 * Throws for known non-callable bindings (classes, non-callable variables).
 * Allows unresolved bindings (e.g. from other export patterns) and imports.
 */
function validateSpecifierBinding(
    localName: string,
    declarations: Map<string, DeclInfo>,
    filePath: string,
): void {
    const info = declarations.get(localName);
    if (!info) {
        // Unresolved — could come from a pattern we don't track. Allow it.
        return;
    }
    if (info.kind === 'class') {
        throw new Error(
            `Class exports are not supported in .backend.ts files. Only function exports are allowed: ${filePath}`,
        );
    }
    if (info.kind === 'variable' && isNonCallableInit(info.init)) {
        throw new Error(
            `Non-function export "${localName}" in backend file ${filePath}. Only function exports are supported — use "export function ${localName}(…) { }" instead.`,
        );
    }
}
