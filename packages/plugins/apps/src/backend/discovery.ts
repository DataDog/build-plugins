// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import { createHash } from 'crypto';
import type { Program } from 'estree';
import { globSync } from 'glob';
import path from 'path';

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
    const exports: string[] = [];
    for (const node of ast.body) {
        if (node.type === 'ExportNamedDeclaration') {
            if (node.declaration) {
                if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
                    exports.push(node.declaration.id.name);
                }
                if (node.declaration.type === 'VariableDeclaration') {
                    for (const decl of node.declaration.declarations) {
                        if (decl.id.type === 'Identifier') {
                            exports.push(decl.id.name);
                        }
                    }
                }
            }
            for (const spec of node.specifiers) {
                if (spec.exported.type === 'Identifier') {
                    if (spec.exported.name === 'default') {
                        throw new Error(
                            `Default exports are not supported in .backend.ts files. Use a named export instead: ${filePath}`,
                        );
                    }
                    exports.push(spec.exported.name);
                }
            }
        }
        if (node.type === 'ExportDefaultDeclaration') {
            throw new Error(
                `Default exports are not supported in .backend.ts files. Use a named export instead: ${filePath}`,
            );
        }
    }
    return exports;
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
