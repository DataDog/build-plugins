// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    BaseNode,
    CallExpression,
    ExportAllDeclaration,
    ExportNamedDeclaration,
    ImportDeclaration,
    ImportExpression,
    Literal,
    Program,
} from 'estree';
import fsp from 'fs/promises';
import path from 'path';

import { extractConnectionIds } from './extract-connection-ids';
import { isProgramNode } from './type-guards';
import { walkAst } from './walk-ast';

export interface ConnectionIdModuleGraphContext {
    buildRoot: string;
    parse: (code: string, id: string) => BaseNode;
    resolve: (specifier: string, importer: string) => Promise<{ id: string } | null | undefined>;
    load?: (id: string) => Promise<LoadedModule | string | null | undefined>;
    transformWithEsbuild?: (
        code: string,
        id: string,
        options: { loader: EsbuildLoader },
    ) => Promise<{ code: string }>;
    addWatchFile?: (id: string) => void;
}

interface LoadedModule {
    code?: string | null;
}

interface ParsedModuleRecord {
    id: string;
    ast: Program;
    dependencies: ModuleDependency[];
    connectionIds: string[];
}

interface ModuleDependency {
    specifier: string;
    kind: 'static' | 'dynamic-import' | 'require';
}

type NodeWithImportKind = BaseNode & { importKind?: string; exportKind?: string };
type StringLiteral = Literal & { value: string };
type NodeWithSource = ImportDeclaration | ExportNamedDeclaration | ExportAllDeclaration;
type ImportCallExpression = CallExpression & { callee: { type: 'Import' } };
type EsbuildLoader = 'js' | 'jsx' | 'ts' | 'tsx';

const DISALLOWED_GRAPH_DIRS = new Set(['node_modules', 'dist', 'build', '.vite']);
const PARSEABLE_FILE_RE = /\.(mjs|cjs|js|jsx|mts|cts|ts|tsx)$/;
const ESBUILD_FILE_RE = /\.(jsx|mts|cts|ts|tsx)$/;
const VIRTUAL_ID_RE = /^(?:\0|virtual:)/;

/**
 * Extracts the conservative backend-file connection ID union from the entry
 * module and every statically reachable local module.
 */
export async function extractConnectionIdsFromModuleGraph(
    entryAst: BaseNode,
    entryId: string,
    context: ConnectionIdModuleGraphContext,
): Promise<string[]> {
    const entryProgram = ensureProgram(entryAst, entryId);
    const modules = new Map<string, ParsedModuleRecord>();
    const connectionIds = new Set<string>();
    const pending = [normalizeModuleId(entryId)];

    modules.set(normalizeModuleId(entryId), createParsedModuleRecord(entryId, entryProgram));

    while (pending.length > 0) {
        const moduleId = pending.shift()!;
        const record = modules.get(moduleId);
        if (!record) {
            continue;
        }

        context.addWatchFile?.(record.id);

        for (const connectionId of record.connectionIds) {
            connectionIds.add(connectionId);
        }

        for (const dependency of record.dependencies) {
            if (dependency.kind === 'dynamic-import' && !shouldFailDynamicImport(dependency)) {
                continue;
            }

            if (dependency.kind !== 'static') {
                throw unsupportedModuleGraphDependency(
                    entryId,
                    `${dependency.kind} ${dependency.specifier}`,
                );
            }

            if (!shouldResolveStaticDependency(dependency.specifier)) {
                continue;
            }

            const resolved = await context.resolve(dependency.specifier, record.id);
            if (!resolved) {
                throw unsupportedModuleGraphDependency(
                    entryId,
                    `unresolved local import ${dependency.specifier} from ${record.id}`,
                );
            }

            const resolvedId = normalizeModuleId(resolved.id);
            if (!shouldTraverseResolvedModule(resolvedId, context.buildRoot)) {
                continue;
            }

            if (modules.has(resolvedId)) {
                continue;
            }

            const moduleRecord = await loadParsedModuleRecord(resolvedId, context);
            modules.set(resolvedId, moduleRecord);
            pending.push(resolvedId);
        }
    }

    return [...connectionIds].sort();
}

function createParsedModuleRecord(id: string, ast: Program): ParsedModuleRecord {
    return {
        id: normalizeModuleId(id),
        ast,
        dependencies: collectModuleDependencies(ast),
        connectionIds: extractConnectionIds(ast, id),
    };
}

async function loadParsedModuleRecord(
    moduleId: string,
    context: ConnectionIdModuleGraphContext,
): Promise<ParsedModuleRecord> {
    const code = await loadModuleCode(moduleId, context);
    const ast = await parseModuleCode(code, moduleId, context);
    return createParsedModuleRecord(moduleId, ast);
}

async function loadModuleCode(
    moduleId: string,
    context: ConnectionIdModuleGraphContext,
): Promise<string> {
    const loaded = await context.load?.(moduleId);
    if (typeof loaded === 'string') {
        return loaded;
    }
    if (loaded?.code !== undefined && loaded.code !== null) {
        return loaded.code;
    }
    return fsp.readFile(moduleId, 'utf8');
}

async function parseModuleCode(
    code: string,
    moduleId: string,
    context: ConnectionIdModuleGraphContext,
): Promise<Program> {
    try {
        return ensureProgram(context.parse(code, moduleId), moduleId);
    } catch (parseError) {
        if (!ESBUILD_FILE_RE.test(moduleId) || !context.transformWithEsbuild) {
            throw parseError;
        }

        const transformed = await context.transformWithEsbuild(code, moduleId, {
            loader: getEsbuildLoader(moduleId),
        });
        return ensureProgram(context.parse(transformed.code, moduleId), moduleId);
    }
}

function collectModuleDependencies(ast: Program): ModuleDependency[] {
    const dependencies: ModuleDependency[] = [];

    for (const node of ast.body) {
        const dependency = getStaticDependency(node);
        if (dependency) {
            dependencies.push(dependency);
        }
    }

    walkAst(ast, dependencies, {
        ImportExpression(node, { state }) {
            state.push({
                specifier: getImportExpressionSpecifier(node),
                kind: 'dynamic-import',
            });
        },
        CallExpression(node, { state }) {
            if (isImportCallExpression(node)) {
                state.push({
                    specifier: getImportCallSpecifier(node),
                    kind: 'dynamic-import',
                });
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

function getStaticDependency(node: Program['body'][number]): ModuleDependency | undefined {
    if (node.type === 'ImportDeclaration') {
        return getSourceDependency(node);
    }
    if (node.type === 'ExportNamedDeclaration' && node.source) {
        return getSourceDependency(node);
    }
    if (node.type === 'ExportAllDeclaration') {
        return getSourceDependency(node);
    }
    return undefined;
}

function getSourceDependency(node: NodeWithSource): ModuleDependency | undefined {
    if (isTypeOnly(node)) {
        return undefined;
    }
    if (!isStringLiteral(node.source)) {
        return undefined;
    }
    return { specifier: node.source.value, kind: 'static' };
}

function shouldResolveStaticDependency(specifier: string): boolean {
    return isLocalSpecifier(specifier);
}

function shouldFailDynamicImport(dependency: ModuleDependency): boolean {
    return (
        dependency.specifier === 'non-literal dynamic import' ||
        isLocalSpecifier(dependency.specifier)
    );
}

function shouldTraverseResolvedModule(moduleId: string, buildRoot: string): boolean {
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

function getRequireSpecifier(node: CallExpression): string {
    return getLiteralSpecifier(node.arguments[0], 'local require');
}

function getLiteralSpecifier(node: unknown, fallback: string): string {
    if (isStringLiteral(node)) {
        return node.value;
    }
    return fallback;
}

function isImportCallExpression(node: CallExpression): node is ImportCallExpression {
    return (node.callee as { type: string }).type === 'Import';
}

function isLocalRequireCall(node: CallExpression): boolean {
    if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') {
        return false;
    }
    const [source] = node.arguments;
    return !source || !isStringLiteral(source) || isLocalSpecifier(source.value);
}

function isLocalSpecifier(specifier: string): boolean {
    return specifier.startsWith('.') || specifier.startsWith('/');
}

function isTypeOnly(node: NodeWithImportKind): boolean {
    return node.importKind === 'type' || node.exportKind === 'type';
}

function isStringLiteral(node: unknown): node is StringLiteral {
    return (
        typeof node === 'object' &&
        node !== null &&
        (node as { type?: string }).type === 'Literal' &&
        typeof (node as { value?: unknown }).value === 'string'
    );
}

function ensureProgram(ast: BaseNode, filePath: string): Program {
    if (!isProgramNode(ast)) {
        throw new Error(
            `Expected a Program node from this.parse() for ${filePath}, got ${ast.type}`,
        );
    }
    return ast;
}

function normalizeModuleId(id: string): string {
    return id.split('?')[0];
}

function getEsbuildLoader(moduleId: string): EsbuildLoader {
    if (moduleId.endsWith('.tsx')) {
        return 'tsx';
    }
    if (moduleId.endsWith('.jsx')) {
        return 'jsx';
    }
    if (moduleId.endsWith('.ts') || moduleId.endsWith('.mts') || moduleId.endsWith('.cts')) {
        return 'ts';
    }
    return 'js';
}

function unsupportedModuleGraphDependency(filePath: string, unsupported: string): Error {
    return new Error(
        `Unsupported local module graph for ${filePath}: ${unsupported} could hide an action-catalog connectionId.`,
    );
}
