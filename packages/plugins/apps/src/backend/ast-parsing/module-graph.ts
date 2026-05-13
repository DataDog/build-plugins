// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode, ImportExpression, Program, SimpleCallExpression } from 'estree';
import path from 'path';

import { ensureProgram, isStringLiteral } from './type-guards';
import { walkAst } from './walk-ast';

export interface ParsedModuleRecord {
    id: string;
    ast: Program;
    staticDependencies: string[];
    unsupportedDependencies: ModuleDependency[];
}

export interface ModuleDependency {
    specifier: string;
    kind: 'dynamic-import' | 'require';
}

type ImportCallExpression = SimpleCallExpression & { callee: { type: 'Import' } };

const DISALLOWED_GRAPH_DIRS = new Set(['node_modules', 'dist', 'build', '.vite']);
const PARSEABLE_FILE_RE = /\.(mjs|cjs|js|jsx|mts|cts|ts|tsx)$/;
const VIRTUAL_ID_RE = /^(?:\0|virtual:)/;

/**
 * Creates the per-module analysis record consumed by backend-entry reachability
 * analysis. The caller supplies already-resolved static dependency IDs from the
 * backend build graph instead of asking this module to resolve/load files.
 *
 * Returns null when the module is outside the analyzable app-local backend
 * graph, allowing backend build collectors to skip virtual/package/generated
 * modules without duplicating graph filtering rules.
 */
export function createParsedModuleRecord(
    moduleId: string,
    buildRoot: string,
    ast: BaseNode,
    staticDependencies: string[] = [],
): ParsedModuleRecord | null {
    const normalizedId = normalizeModuleId(moduleId);
    if (!shouldTraverseCollectedModule(normalizedId, buildRoot)) {
        return null;
    }

    const program = ensureProgram(ast, moduleId);

    return {
        id: normalizedId,
        ast: program,
        staticDependencies: staticDependencies.map(normalizeModuleId),
        unsupportedDependencies: collectUnsupportedModuleDependencies(program),
    };
}

/**
 * Keeps reachability traversal scoped to app-local JavaScript/TypeScript source
 * modules that the backend build collector can safely analyze.
 */
export function shouldTraverseCollectedModule(moduleId: string, buildRoot: string): boolean {
    if (VIRTUAL_ID_RE.test(moduleId) || !PARSEABLE_FILE_RE.test(moduleId)) {
        return false;
    }

    const relativePath = path.relative(path.resolve(buildRoot), moduleId);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return false;
    }

    return !relativePath.split(path.sep).some((segment) => DISALLOWED_GRAPH_DIRS.has(segment));
}

/**
 * Drops query-string suffixes from Vite/Rollup module IDs so records and graph
 * visits use one stable key per source module.
 */
export function normalizeModuleId(id: string): string {
    return id.split('?')[0];
}

/**
 * Builds the common fail-closed error for graph shapes that could hide an
 * action-catalog connection ID.
 */
export function unsupportedModuleGraphDependency(filePath: string, unsupported: string): Error {
    return new Error(
        `Unsupported local module graph for ${filePath}: ${unsupported} could hide an action-catalog connectionId.`,
    );
}

/**
 * Finds dependency forms that cannot be represented by the static dependency
 * IDs supplied by the backend build collector.
 */
function collectUnsupportedModuleDependencies(ast: Program): ModuleDependency[] {
    const dependencies: ModuleDependency[] = [];

    walkAst(ast, dependencies, {
        ImportExpression(node, { state }) {
            const specifier = getImportExpressionSpecifier(node);
            if (shouldFailDynamicImport(specifier)) {
                state.push({ specifier, kind: 'dynamic-import' });
            }
        },
        CallExpression(node, { state }) {
            if (isImportCallExpression(node)) {
                const specifier = getImportCallSpecifier(node);
                if (shouldFailDynamicImport(specifier)) {
                    state.push({ specifier, kind: 'dynamic-import' });
                }
                return;
            }

            if (isLocalRequireCall(node)) {
                state.push({
                    specifier: getRequireSpecifier(node),
                    kind: 'require',
                });
            }
        },
    });

    return dependencies;
}

/**
 * Dynamic package imports are skipped, but local or non-literal dynamic imports
 * could hide app-local action-catalog calls and must fail closed.
 */
function shouldFailDynamicImport(specifier: string): boolean {
    return specifier === 'non-literal dynamic import' || isLocalSpecifier(specifier);
}

/**
 * Reads the static string specifier from an ESTree dynamic import expression.
 */
function getImportExpressionSpecifier(node: ImportExpression): string {
    return getLiteralSpecifier(node.source, 'non-literal dynamic import');
}

/**
 * Reads the static string specifier from Rollup's call-expression form for
 * dynamic import.
 */
function getImportCallSpecifier(node: ImportCallExpression): string {
    return getLiteralSpecifier(node.arguments[0], 'non-literal dynamic import');
}

/**
 * Reads the static string specifier from a CommonJS require call.
 */
function getRequireSpecifier(node: SimpleCallExpression): string {
    return getLiteralSpecifier(node.arguments[0], 'local require');
}

/**
 * Returns a literal string value when available, otherwise a diagnostic label
 * used in fail-closed error messages.
 */
function getLiteralSpecifier(node: unknown, fallback: string): string {
    if (isStringLiteral(node)) {
        return node.value;
    }
    return fallback;
}

/**
 * Narrows Rollup's dynamic import call-expression representation.
 */
function isImportCallExpression(node: SimpleCallExpression): node is ImportCallExpression {
    return (node.callee as { type: string }).type === 'Import';
}

/**
 * Detects local CommonJS require calls. Package require calls are ignored
 * because package modules are outside the app-local backend graph.
 */
function isLocalRequireCall(node: SimpleCallExpression): boolean {
    if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') {
        return false;
    }
    const [source] = node.arguments;
    return !source || !isStringLiteral(source) || isLocalSpecifier(source.value);
}

/**
 * Returns whether an import specifier points at an app-local path.
 */
function isLocalSpecifier(specifier: string): boolean {
    return specifier.startsWith('.') || specifier.startsWith('/');
}
