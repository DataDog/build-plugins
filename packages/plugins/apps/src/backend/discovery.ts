// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import { createHash } from 'crypto';
import type { Declaration, Identifier, Program } from 'estree';
import { globSync } from 'glob';
import path from 'path';
import type { AstNode } from 'rollup';

export interface BackendFunctionRef {
    /** Relative path from project root to the .backend.ts file (without extension) */
    path: string;
    /** Exported function name */
    name: string;
}

export interface BackendFunction {
    /** The BackendFunctionRef identifying this function */
    ref: BackendFunctionRef;
    /** Absolute path to the .backend.ts source file */
    entryPath: string;
}

export interface BackendFileInfo {
    /** Absolute path to the .backend.ts source file */
    absolutePath: string;
    /** Relative path from project root, with .backend.{ext} stripped (used as BackendFunctionRef.path) */
    refPath: string;
}

/**
 * Encode a BackendFunctionRef into an opaque query name string.
 * Uses the full SHA-256 hash of the path so that backend file structure
 * is never leaked into frontend assets.
 *
 * This is the single source of truth for query name encoding — used by
 * proxy codegen, the production build, and the dev server.
 */
export function encodeQueryName(ref: BackendFunctionRef): string {
    const pathHash = createHash('sha256').update(ref.path).digest('hex');
    return `${pathHash}.${ref.name}`;
}

/**
 * Type guard: this.parse() returns AstNode (estree.Node with location info)
 * but produces a Program node at the top level.
 */
function isProgramNode(node: AstNode): node is AstNode & Program {
    return node.type === 'Program';
}

/**
 * Parse export names from an AST node returned by `this.parse()`.
 * Returns null if the file should be skipped (not a Program, parse error,
 * or no exports found).
 */
export function parseExportNames(ast: AstNode, id: string, log: Logger): string[] | null {
    try {
        if (!isProgramNode(ast)) {
            return null;
        }
        const names = extractExportedFunctions(ast, id);
        if (names.length === 0) {
            log.debug(`No exported functions found in ${id}`);
            return null;
        }
        return names;
    } catch (error) {
        log.error(
            `Failed to parse exports from ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
    }
}

/**
 * Extract exported value (non-type) symbols from an ESTree AST.
 * Expects plain JavaScript — TypeScript types must already be stripped
 * (e.g. by Vite's built-in esbuild transform that runs before our hook).
 *
 * Used inside the `transform` hook where `this.parse(code)` provides the AST.
 *
 * @param ast - ESTree Program AST (from `this.parse()` in unplugin's transform hook)
 * @param filePath - Path to the source file (used in error messages)
 */
export function extractExportedFunctions(ast: Program, filePath: string): string[] {
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
            names.push(...namesFromDeclaration(node.declaration));
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

/**
 * Extract identifier names from an exported declaration node.
 * Handles `export function foo()` and `export const foo = ...` forms.
 */
function namesFromDeclaration(decl: Declaration): string[] {
    if (decl.type === 'FunctionDeclaration' && decl.id) {
        return [decl.id.name];
    }
    if (decl.type === 'VariableDeclaration') {
        return decl.declarations
            .filter((d): d is typeof d & { id: Identifier } => d.id.type === 'Identifier')
            .map((d) => d.id.name);
    }
    return [];
}

/**
 * Discover backend files by scanning for `*.backend.{ts,tsx,js,jsx}` files
 * anywhere in the project (excluding node_modules, dist, etc.).
 *
 * Returns file info only — no export parsing. Exports are discovered lazily
 * during the `transform` hook when Vite has already stripped TypeScript types.
 *
 * Must be sync because it runs in getPlugins() before the build starts.
 */
export function discoverBackendFiles(projectRoot: string, log: Logger): BackendFileInfo[] {
    const pattern = '**/*.backend.{ts,tsx,js,jsx}';
    const files = globSync(pattern, {
        cwd: projectRoot,
        ignore: ['**/node_modules/**', '**/dist/**', '**/.dist/**'],
        absolute: true,
    });

    if (files.length === 0) {
        log.debug(`No .backend.ts files found in ${projectRoot}`);
        return [];
    }

    const result: BackendFileInfo[] = [];
    for (const absolutePath of files) {
        const relativePath = path.relative(projectRoot, absolutePath);
        const refPath = relativePath.replace(/\.backend\.\w+$/, '');
        result.push({ absolutePath, refPath });
    }

    log.debug(
        `Discovered ${result.length} backend file(s): ${result.map((f) => f.refPath).join(', ')}`,
    );
    return result;
}
