// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import * as acorn from 'acorn';
import { createHash } from 'crypto';
import { transformSync } from 'esbuild';
import fs from 'fs';
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
 * Discover exported value (non-type) symbols from a `.backend.ts` file.
 * Uses esbuild to strip TypeScript types, then acorn (the same parser Rollup
 * uses internally via `this.parse`) to produce an ESTree AST.
 */
export function discoverExportedFunctions(filePath: string): string[] {
    const source = fs.readFileSync(filePath, 'utf-8');

    // Strip TypeScript types with esbuild — this removes `export type`,
    // `export interface`, `export { type Foo }`, etc.
    const { code } = transformSync(source, { loader: 'ts', format: 'esm' });

    // Parse the plain JS with acorn (same parser Rollup/Vite use internally).
    const ast = acorn.parse(code, { sourceType: 'module', ecmaVersion: 'latest' });

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
            // export { foo, bar } — also the form esbuild normalizes to.
            // esbuild also normalizes `export default` into `export { x as default }`.
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
        // Catch `export default` that wasn't normalized (plain JS input).
        if (node.type === 'ExportDefaultDeclaration') {
            throw new Error(
                `Default exports are not supported in .backend.ts files. Use a named export instead: ${filePath}`,
            );
        }
    }
    return exports;
}

/**
 * Discover backend functions by scanning for `*.backend.ts` files anywhere
 * in the project (excluding node_modules, dist, etc.).
 *
 * Each exported value function in a `.backend.ts` file produces one
 * `BackendFunction` entry with a `BackendFunctionRef`.
 *
 * Must be sync because it runs in getPlugins() before the build starts.
 */
export function discoverBackendFunctions(projectRoot: string, log: Logger): BackendFunction[] {
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

    const functions: BackendFunction[] = [];

    for (const absolutePath of files) {
        const relativePath = path.relative(projectRoot, absolutePath);
        // Strip the .backend.{ext} suffix to get the path component of BackendFunctionRef
        const refPath = relativePath.replace(/\.backend\.\w+$/, '');

        let exportNames: string[];
        try {
            exportNames = discoverExportedFunctions(absolutePath);
        } catch (error) {
            log.error(
                `Failed to parse exports from ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
        }

        if (exportNames.length === 0) {
            log.debug(`No exported functions found in ${relativePath}`);
            continue;
        }

        for (const exportName of exportNames) {
            functions.push({
                ref: { path: refPath, name: exportName },
                entryPath: absolutePath,
            });
        }
    }

    log.debug(
        `Discovered ${functions.length} backend function(s): ${functions.map((f) => `${f.ref.path}/${f.ref.name}`).join(', ')}`,
    );
    return functions;
}
