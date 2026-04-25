// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Declaration, Expression, Node, Program } from 'estree';
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
 * Describes a single named export from a backend file, with enough information
 * to locate the function body (for static analysis) or identify a re-exported
 * import (whose body lives in another module).
 *
 * The two `body`-carrying variants differ only in origin — both resolve to a
 * function body we can scan in this file — so they share a single kind.
 * `imported` has no locally-visible body; callers must handle that case.
 */
export type ExportedBinding =
    | {
          /** `export function foo() {}` or `function foo() {}; export { foo }` or arrow-const equivalents */
          kind: 'local';
          name: string;
          body: Node;
      }
    | {
          /** `import { foo } from './x'; export { foo }` — body is in another module */
          kind: 'imported';
          name: string;
          /** Module specifier, e.g. `'./handlers'` */
          source: string;
          /** The remote name being imported (may differ from `name` when aliased) */
          imported: string;
      };

/**
 * Enumerate every named export in a backend file along with the information
 * needed to locate its implementation. Validates that each export is function-like
 * and rejects unsupported shapes (default exports, `export *`, class exports,
 * non-callable variable exports, destructured exports).
 *
 * Expects plain JavaScript — TypeScript types must already be stripped.
 *
 * This is the single source of truth for "what backend export shapes are
 * supported." Both name discovery and connection-id extraction consume it so
 * support for a new shape only has to be added here.
 */
export function enumerateBackendExports(ast: AstNode, filePath: string): ExportedBinding[] {
    if (!isProgramNode(ast)) {
        throw new Error(
            `Expected a Program node from this.parse() for ${filePath}, got ${ast.type}`,
        );
    }

    // Map of top-level declarations keyed by local name, used both to validate
    // specifier exports and to locate bodies for `function foo(){}; export { foo }`.
    const declarations = buildDeclarationMap(ast);

    const bindings: ExportedBinding[] = [];
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
            bindings.push(...bindingsFromDeclaration(node.declaration, filePath));
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
            if (spec.local.type !== 'Identifier') {
                continue;
            }
            // Re-export from another module: `export { X } from './foo'` / `export { Y as X } from './foo'`.
            // Not currently surfaced as a separate kind — treat as imported so consumers can log
            // and skip. If we ever need to distinguish, add a new kind here.
            if (node.source && typeof node.source.value === 'string') {
                bindings.push({
                    kind: 'imported',
                    name: spec.exported.name,
                    source: node.source.value,
                    imported: spec.local.name,
                });
                continue;
            }
            const info = declarations.get(spec.local.name);
            validateSpecifierBinding(spec.local.name, info, filePath);
            bindings.push(bindingFromDeclInfo(spec.exported.name, spec.local.name, info));
        }
    }
    return bindings;
}

/**
 * Back-compat name-only view used by callers that just want the list of
 * exported names (e.g. proxy codegen, logging).
 */
export function extractExportedFunctions(ast: AstNode, filePath: string): string[] {
    return enumerateBackendExports(ast, filePath).map((b) => b.name);
}

function isProgramNode(node: AstNode): node is AstNode & Program {
    return node.type === 'Program';
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
 * Extract bindings from an exported declaration node.
 * Handles `export function foo()` and `export const foo = ...` forms.
 * Throws when a variable export has a non-callable initializer.
 */
function bindingsFromDeclaration(decl: Declaration, filePath: string): ExportedBinding[] {
    // export function add(a, b) { return a + b; }
    if (decl.type === 'FunctionDeclaration' && decl.id) {
        return [{ kind: 'local', name: decl.id.name, body: decl.body }];
    }
    // export class MyClass {} — classes are not callable as RPC endpoints
    if (decl.type === 'ClassDeclaration') {
        throw new Error(
            `Class exports are not supported in .backend.ts files. Only function exports are allowed: ${filePath}`,
        );
    }
    if (decl.type === 'VariableDeclaration') {
        return decl.declarations.flatMap((d): ExportedBinding[] => {
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
            if (
                d.init &&
                (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression')
            ) {
                return [{ kind: 'local', name: d.id.name, body: d.init.body }];
            }
            // export const handler = importedFn;  — ambiguous, conservatively treat as imported
            // so connection-id extraction can skip/log without failing the build.
            if (d.init && d.init.type === 'Identifier') {
                return [
                    {
                        kind: 'imported',
                        name: d.id.name,
                        // We don't know the original source here; leaving blank signals "local relay".
                        source: '<local-alias>',
                        imported: d.init.name,
                    },
                ];
            }
            // Other ambiguous forms (CallExpression, etc.): treat as imported/opaque.
            return [
                {
                    kind: 'imported',
                    name: d.id.name,
                    source: '<opaque>',
                    imported: d.id.name,
                },
            ];
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
    | { kind: 'function'; body: Node }
    | { kind: 'class' }
    | { kind: 'variable'; init: Expression | null | undefined }
    | { kind: 'import'; source: string; imported: string };

/**
 * Build a map from identifier name → declaration info for all top-level
 * statements. Used both to validate `export { name }` specifiers and to
 * locate function bodies for specifier-form exports.
 */
function buildDeclarationMap(ast: Program): Map<string, DeclInfo> {
    const map = new Map<string, DeclInfo>();
    for (const node of ast.body) {
        if (node.type === 'FunctionDeclaration' && node.id) {
            // handles: function add(a, b) { return a + b; }
            map.set(node.id.name, { kind: 'function', body: node.body });
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
        } else if (node.type === 'ImportDeclaration' && typeof node.source.value === 'string') {
            // handles: import { handler } from './other';
            const source = node.source.value;
            for (const spec of node.specifiers) {
                if (spec.type === 'ImportSpecifier') {
                    const imported =
                        spec.imported.type === 'Identifier'
                            ? spec.imported.name
                            : String(spec.imported.value);
                    map.set(spec.local.name, { kind: 'import', source, imported });
                } else {
                    // Default / namespace imports: we allow exporting them but can't
                    // statically locate a function body.
                    map.set(spec.local.name, {
                        kind: 'import',
                        source,
                        imported: spec.local.name,
                    });
                }
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
    info: DeclInfo | undefined,
    filePath: string,
): void {
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

/**
 * Turn a resolved specifier binding into an {@link ExportedBinding}. Called
 * after {@link validateSpecifierBinding}, so opaque/rejected shapes won't
 * reach this point.
 */
function bindingFromDeclInfo(
    exportedName: string,
    localName: string,
    info: DeclInfo | undefined,
): ExportedBinding {
    if (info?.kind === 'function') {
        return { kind: 'local', name: exportedName, body: info.body };
    }
    if (info?.kind === 'variable' && info.init) {
        if (
            info.init.type === 'ArrowFunctionExpression' ||
            info.init.type === 'FunctionExpression'
        ) {
            return { kind: 'local', name: exportedName, body: info.init.body };
        }
    }
    if (info?.kind === 'import') {
        return {
            kind: 'imported',
            name: exportedName,
            source: info.source,
            imported: info.imported,
        };
    }
    // Ambiguous (e.g. `const handler = someCall(); export { handler }`) or a
    // binding we can't resolve — treat as imported/opaque so connection-id
    // extraction skips it rather than failing the build.
    return {
        kind: 'imported',
        name: exportedName,
        source: '<opaque>',
        imported: localName,
    };
}
