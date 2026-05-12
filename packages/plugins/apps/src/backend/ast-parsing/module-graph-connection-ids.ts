// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode, ImportExpression, Program, SimpleCallExpression } from 'estree';
import path from 'path';

import { extractConnectionIds } from './extract-connection-ids';
import { ensureProgram, isStringLiteral } from './type-guards';
import { walkAst } from './walk-ast';

export interface ParsedModuleRecord {
    id: string;
    ast: Program;
    staticDependencies: string[];
    unsupportedDependencies: ModuleDependency[];
    connectionIds: string[];
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
 */
export function createParsedModuleRecord(
    id: string,
    ast: BaseNode,
    staticDependencies: string[] = [],
): ParsedModuleRecord {
    const program = ensureProgram(ast, id);

    return {
        id: normalizeModuleId(id),
        ast: program,
        staticDependencies: staticDependencies.map(normalizeModuleId),
        unsupportedDependencies: collectUnsupportedModuleDependencies(program),
        connectionIds: extractConnectionIds(program, id),
    };
}

/**
 * Extracts the conservative backend-file connection ID union from parsed module
 * records collected while the backend bundler walked the real execution graph.
 */
export function extractConnectionIdsFromParsedModuleGraph(
    entryId: string,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    buildRoot: string,
): string[] {
    const connectionIds = new Set<string>();
    const pending = [normalizeModuleId(entryId)];
    const visited = new Set<string>();

    while (pending.length > 0) {
        const moduleId = pending.shift()!;
        if (visited.has(moduleId)) {
            continue;
        }
        visited.add(moduleId);

        const record = modules.get(moduleId);
        if (!record) {
            throw unsupportedModuleGraphDependency(
                entryId,
                `missing parsed module record for ${moduleId}`,
            );
        }

        for (const connectionId of record.connectionIds) {
            connectionIds.add(connectionId);
        }

        for (const dependency of record.unsupportedDependencies) {
            throw unsupportedModuleGraphDependency(
                entryId,
                `${dependency.kind} ${dependency.specifier}`,
            );
        }

        for (const dependencyId of record.staticDependencies) {
            if (!shouldTraverseCollectedModule(dependencyId, buildRoot)) {
                continue;
            }

            if (!modules.has(dependencyId)) {
                throw unsupportedModuleGraphDependency(
                    entryId,
                    `uncollected local import ${dependencyId} from ${record.id}`,
                );
            }

            pending.push(dependencyId);
        }
    }

    return [...connectionIds].sort();
}

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

function shouldFailDynamicImport(specifier: string): boolean {
    return specifier === 'non-literal dynamic import' || isLocalSpecifier(specifier);
}

export function shouldCollectBackendModule(moduleId: string, buildRoot: string): boolean {
    return shouldTraverseCollectedModule(normalizeModuleId(moduleId), buildRoot);
}

function shouldTraverseCollectedModule(moduleId: string, buildRoot: string): boolean {
    if (VIRTUAL_ID_RE.test(moduleId) || !PARSEABLE_FILE_RE.test(moduleId)) {
        return false;
    }

    const relativePath = path.relative(path.resolve(buildRoot), moduleId);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return false;
    }

    return !relativePath.split(path.sep).some((segment) => DISALLOWED_GRAPH_DIRS.has(segment));
}

function getImportExpressionSpecifier(node: ImportExpression): string {
    return getLiteralSpecifier(node.source, 'non-literal dynamic import');
}

function getImportCallSpecifier(node: ImportCallExpression): string {
    return getLiteralSpecifier(node.arguments[0], 'non-literal dynamic import');
}

function getRequireSpecifier(node: SimpleCallExpression): string {
    return getLiteralSpecifier(node.arguments[0], 'local require');
}

function getLiteralSpecifier(node: unknown, fallback: string): string {
    if (isStringLiteral(node)) {
        return node.value;
    }
    return fallback;
}

function isImportCallExpression(node: SimpleCallExpression): node is ImportCallExpression {
    return (node.callee as { type: string }).type === 'Import';
}

function isLocalRequireCall(node: SimpleCallExpression): boolean {
    if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') {
        return false;
    }
    const [source] = node.arguments;
    return !source || !isStringLiteral(source) || isLocalSpecifier(source.value);
}

function isLocalSpecifier(specifier: string): boolean {
    return specifier.startsWith('.') || specifier.startsWith('/');
}

export function normalizeModuleId(id: string): string {
    return id.split('?')[0];
}

function unsupportedModuleGraphDependency(filePath: string, unsupported: string): Error {
    return new Error(
        `Unsupported local module graph for ${filePath}: ${unsupported} could hide an action-catalog connectionId.`,
    );
}
