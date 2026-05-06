// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    CallExpression,
    ExportNamedDeclaration,
    Expression,
    ImportDeclaration,
    ImportSpecifier,
    MemberExpression,
    Node,
    ObjectExpression,
    Program,
    Property,
    Statement,
    Super,
    TemplateLiteral,
    VariableDeclaration,
    VariableDeclarator,
} from 'estree';
import fsp from 'fs/promises';
import path from 'path';
import type { AstNode, PluginContext } from 'rollup';
import { transformWithEsbuild } from 'vite';

const ACTION_CATALOG_PACKAGE = '@datadog/action-catalog';
const MAX_CONST_RESOLUTION_DEPTH = 32;
const GENERATED_SEGMENT_RE = /[/\\](?:dist|build|\.vite)(?:[/\\]|$)/;

type MutableKind = 'let' | 'var';

interface ActionCatalogImports {
    functions: Set<string>;
    namespaces: Set<string>;
    unsupportedAliases: Set<string>;
}

interface ImportBinding {
    source: string;
    imported: string;
}

interface ModuleBindings {
    consts: Map<string, Expression>;
    mutables: Map<string, MutableKind>;
    importedIdentifiers: Set<string>;
    importedNamespaces: Set<string>;
    importBindings: Map<string, ImportBinding>;
}

interface ParsedModule {
    id: string;
    ast: Program;
    actionImports: ActionCatalogImports;
    bindings: ModuleBindings;
}

interface GraphContext {
    ctx: PluginContext;
    buildRoot: string;
    moduleCache: Map<string, ParsedModule>;
}

class ConnectionIdExtractionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConnectionIdExtractionError';
    }
}

/**
 * Signals that a requested export was not found while traversing re-export chains.
 */
class ExportNotFoundError extends ConnectionIdExtractionError {}

/**
 * Extracts action-catalog connection IDs from either one AST or a reachable module graph.
 */
export const extractConnectionIds = ((
    ctxOrAst: PluginContext | AstNode,
    astOrFilePath: AstNode | string,
    filePath?: string,
    buildRoot?: string,
): string[] | Promise<string[]> => {
    if (typeof astOrFilePath === 'string') {
        return extractConnectionIdsFromAst(ctxOrAst as AstNode, astOrFilePath);
    }

    return extractConnectionIdsFromModuleGraph(
        ctxOrAst as PluginContext,
        astOrFilePath,
        filePath!,
        buildRoot ?? path.dirname(filePath!),
    );
}) as {
    (ast: AstNode, filePath: string): string[];
    (ctx: PluginContext, ast: AstNode, filePath: string, buildRoot?: string): Promise<string[]>;
};

/**
 * Extracts connection IDs from every analyzable module reachable from a backend entry module.
 */
async function extractConnectionIdsFromModuleGraph(
    ctx: PluginContext,
    ast: AstNode,
    filePath: string,
    buildRoot: string,
): Promise<string[]> {
    // Rollup's this.parse(code) should return the module root for code like
    // `import { request } from '@datadog/action-catalog/http/http';`.
    if (!isProgramNode(ast)) {
        throw new Error(
            `Expected a Program node from this.parse() for ${filePath}, got ${ast.type}`,
        );
    }

    const graph: GraphContext = {
        ctx,
        buildRoot: stripQuery(buildRoot),
        moduleCache: new Map(),
    };
    const modules = await buildReachableModuleGraph(graph, ast, filePath);
    const ids = new Set<string>();

    for (const mod of modules) {
        walkWithScope(mod.ast, mod.actionImports, (node, shadowedBindings) => {
            // Only call sites such as `request({ connectionId: 'abc' })` can
            // contain backend action connection IDs.
            if (node.type !== 'CallExpression') {
                return;
            }
            failIfUnsupportedActionCatalogUsage(node, mod.actionImports, shadowedBindings, mod.id);
        });

        for (const node of collectActionCatalogCalls(mod)) {
            for (const id of await extractIdsFromActionCatalogCallAsync(node, mod, graph)) {
                ids.add(id);
            }
        }
    }

    return [...ids].sort();
}

/**
 * Extracts connection IDs from a single already-parsed backend module AST.
 */
function extractConnectionIdsFromAst(ast: AstNode, filePath: string): string[] {
    // Rollup's this.parse(code) should return the module root for code like
    // `import { request } from '@datadog/action-catalog/http/http';`.
    if (!isProgramNode(ast)) {
        throw new Error(
            `Expected a Program node from this.parse() for ${filePath}, got ${ast.type}`,
        );
    }

    const parsed = makeParsedModule(filePath, ast);
    const ids = new Set<string>();

    walkWithScope(ast, parsed.actionImports, (node, shadowedBindings) => {
        // Only call sites such as `request({ connectionId: 'abc' })` can
        // contain backend action connection IDs.
        if (node.type !== 'CallExpression') {
            return;
        }
        failIfUnsupportedActionCatalogUsage(node, parsed.actionImports, shadowedBindings, filePath);
        if (!isActionCatalogCallee(node.callee, parsed.actionImports, shadowedBindings)) {
            return;
        }

        for (const id of extractIdsFromActionCatalogCall(node, parsed.bindings, filePath)) {
            ids.add(id);
        }
    });

    return [...ids].sort();
}

/**
 * Narrows a Rollup AST node to the ESTree module root produced by this.parse().
 */
function isProgramNode(node: AstNode): node is AstNode & Program {
    return node.type === 'Program';
}

/**
 * Reports whether a whole import declaration is type-only.
 */
function isTypeOnlyImport(node: ImportDeclaration): boolean {
    return (node as ImportDeclaration & { importKind?: string }).importKind === 'type';
}

/**
 * Reports whether a named import specifier is type-only.
 */
function isTypeOnlyImportSpecifier(node: ImportSpecifier): boolean {
    return (node as ImportSpecifier & { importKind?: string }).importKind === 'type';
}

/**
 * Reports whether a named export declaration is type-only.
 */
function isTypeOnlyExport(node: ExportNamedDeclaration): boolean {
    return (node as ExportNamedDeclaration & { exportKind?: string }).exportKind === 'type';
}

/**
 * Reports whether an import source belongs to the action-catalog package.
 */
function isActionCatalogSource(source: string): boolean {
    return source === ACTION_CATALOG_PACKAGE || source.startsWith(`${ACTION_CATALOG_PACKAGE}/`);
}

/**
 * Reports whether a dependency specifier points at a local file.
 */
function isLocalSourceSpecifier(source: string): boolean {
    return source.startsWith('.') || source.startsWith('/');
}

/**
 * Reports whether a variable declaration kind can be reassigned.
 */
function isMutableKind(kind: string): kind is MutableKind {
    return kind === 'let' || kind === 'var';
}

/**
 * Removes Rollup/Vite query suffixes from module IDs.
 */
function stripQuery(id: string): string {
    return id.replace(/\?.*$/, '');
}

/**
 * Normalizes module IDs to POSIX separators for stable graph cache keys.
 */
function toPosix(id: string): string {
    return id.split(path.sep).join('/');
}

/**
 * Reports whether a resolved module ID is inside the app build root.
 */
function isInsideBuildRoot(id: string, buildRoot: string): boolean {
    const rel = path.relative(buildRoot, stripQuery(id));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Reports whether a module ID points at generated output that should not be analyzed.
 */
function isGeneratedOutput(id: string): boolean {
    return GENERATED_SEGMENT_RE.test(stripQuery(id));
}

/**
 * Reports whether a resolved module should be included in the connectionId graph.
 */
function shouldTraverseResolvedId(id: string, buildRoot: string): boolean {
    const cleanId = stripQuery(id);
    if (cleanId.includes('/node_modules/') || cleanId.includes('\\node_modules\\')) {
        return false;
    }
    if (cleanId.startsWith('\0')) {
        return false;
    }
    if (!isInsideBuildRoot(cleanId, buildRoot)) {
        return false;
    }
    return !isGeneratedOutput(cleanId);
}

/**
 * Builds the cached representation used by the module graph analyzer.
 */
function makeParsedModule(id: string, ast: Program): ParsedModule {
    return {
        id: toPosix(id),
        ast,
        actionImports: collectActionCatalogImports(ast),
        bindings: collectModuleBindings(ast),
    };
}

/**
 * Collects top-level module bindings used to resolve connectionId expressions.
 */
function collectModuleBindings(ast: Program): ModuleBindings {
    const consts = new Map<string, Expression>();
    const mutables = new Map<string, MutableKind>();
    const importedIdentifiers = new Set<string>();
    const importedNamespaces = new Set<string>();
    const importBindings = new Map<string, ImportBinding>();

    for (const node of ast.body) {
        if (node.type === 'VariableDeclaration') {
            recordVariableDeclaration(node, consts, mutables);
        } else if (
            node.type === 'ExportNamedDeclaration' &&
            node.declaration?.type === 'VariableDeclaration'
        ) {
            recordVariableDeclaration(node.declaration, consts, mutables);
        } else if (
            node.type === 'ImportDeclaration' &&
            !isTypeOnlyImport(node) &&
            typeof node.source.value === 'string'
        ) {
            for (const spec of node.specifiers) {
                if (spec.type === 'ImportSpecifier') {
                    if (isTypeOnlyImportSpecifier(spec)) {
                        continue;
                    }
                    importedIdentifiers.add(spec.local.name);
                    if (!isActionCatalogSource(node.source.value)) {
                        importBindings.set(spec.local.name, {
                            source: node.source.value,
                            imported: readImportSpecifierName(spec),
                        });
                    }
                } else if (spec.type === 'ImportDefaultSpecifier') {
                    importedIdentifiers.add(spec.local.name);
                    if (!isActionCatalogSource(node.source.value)) {
                        importBindings.set(spec.local.name, {
                            source: node.source.value,
                            imported: 'default',
                        });
                    }
                } else if (spec.type === 'ImportNamespaceSpecifier') {
                    importedNamespaces.add(spec.local.name);
                }
            }
        }
    }

    return { consts, mutables, importedIdentifiers, importedNamespaces, importBindings };
}

/**
 * Reads the imported name from an import specifier.
 */
function readImportSpecifierName(spec: ImportSpecifier): string {
    return spec.imported.type === 'Identifier' ? spec.imported.name : String(spec.imported.value);
}

/**
 * Records top-level const values and mutable names from one variable declaration.
 */
function recordVariableDeclaration(
    declaration: VariableDeclaration,
    consts: Map<string, Expression>,
    mutables: Map<string, MutableKind>,
): void {
    for (const declarator of declaration.declarations) {
        if (declarator.id.type !== 'Identifier') {
            continue;
        }
        if (declaration.kind === 'const' && declarator.init) {
            consts.set(declarator.id.name, declarator.init);
        } else if (isMutableKind(declaration.kind)) {
            mutables.set(declarator.id.name, declaration.kind);
        }
    }
}

/**
 * Collects action-catalog function imports, namespace imports, and unsupported local aliases.
 */
function collectActionCatalogImports(ast: Program): ActionCatalogImports {
    const functions = new Set<string>();
    const namespaces = new Set<string>();
    const unsupportedAliases = new Set<string>();

    for (const node of ast.body) {
        // Keep only action-catalog imports like
        // `import { request } from '@datadog/action-catalog/http/http';`.
        if (
            node.type !== 'ImportDeclaration' ||
            isTypeOnlyImport(node) ||
            typeof node.source.value !== 'string' ||
            !isActionCatalogSource(node.source.value)
        ) {
            continue;
        }

        for (const spec of node.specifiers) {
            // `import { request as httpRequest } from '...'`
            if (spec.type === 'ImportSpecifier') {
                if (!isTypeOnlyImportSpecifier(spec)) {
                    functions.add(spec.local.name);
                }
                // `import request from '@datadog/action-catalog/http/http'`
            } else if (spec.type === 'ImportDefaultSpecifier') {
                functions.add(spec.local.name);
                // `import * as http from '@datadog/action-catalog/http/http'`
            } else if (spec.type === 'ImportNamespaceSpecifier') {
                namespaces.add(spec.local.name);
            }
        }
    }

    walkWithScope(ast, { functions, namespaces, unsupportedAliases }, (node, shadowedBindings) => {
        // Aliases are introduced through declarations like `const action = request`.
        if (node.type !== 'VariableDeclarator') {
            return;
        }
        // `const action = request` aliases a named/default action import.
        if (
            node.id.type === 'Identifier' &&
            node.init?.type === 'Identifier' &&
            functions.has(node.init.name) &&
            !shadowedBindings.has(node.init.name)
        ) {
            unsupportedAliases.add(node.id.name);
            return;
        }
        // `const action = http.request` aliases a namespace action import.
        if (
            node.id.type === 'Identifier' &&
            node.init?.type === 'MemberExpression' &&
            isNamespaceMember(node.init, namespaces, shadowedBindings)
        ) {
            unsupportedAliases.add(node.id.name);
            return;
        }
        // `const { request: action } = http` aliases a namespace action import.
        if (
            node.id.type !== 'ObjectPattern' ||
            node.init?.type !== 'Identifier' ||
            !namespaces.has(node.init.name) ||
            shadowedBindings.has(node.init.name)
        ) {
            return;
        }
        for (const prop of node.id.properties) {
            // In `const { request: action } = http`, `action` is the local binding.
            if (prop.type !== 'Property' || prop.computed) {
                continue;
            }
            if (prop.value.type === 'Identifier') {
                unsupportedAliases.add(prop.value.name);
            }
        }
    });

    return { functions, namespaces, unsupportedAliases };
}

/**
 * Builds the ordered list of modules reachable from the backend entry module.
 */
async function buildReachableModuleGraph(
    graph: GraphContext,
    entryAst: Program,
    entryId: string,
): Promise<ParsedModule[]> {
    const ordered: ParsedModule[] = [];
    const queue: ParsedModule[] = [];
    const entry = makeParsedModule(entryId, entryAst);

    graph.moduleCache.set(entry.id, entry);
    ordered.push(entry);
    queue.push(entry);

    for (let i = 0; i < queue.length; i += 1) {
        const mod = queue[i];
        assertNoUnsupportedDynamicLocalDependencies(mod);

        for (const source of collectStaticDependencySpecifiers(mod.ast)) {
            if (isActionCatalogSource(source)) {
                continue;
            }
            const resolvedId = await resolveModuleId(graph.ctx, mod.id, source, {
                required: isLocalSourceSpecifier(source),
            });
            if (!resolvedId || !shouldTraverseResolvedId(resolvedId, graph.buildRoot)) {
                continue;
            }
            const cached = graph.moduleCache.get(resolvedId);
            if (cached) {
                continue;
            }
            const loaded = await loadParsedModule(graph, resolvedId);
            graph.moduleCache.set(loaded.id, loaded);
            ordered.push(loaded);
            queue.push(loaded);
        }
    }

    return ordered;
}

/**
 * Collects static import and re-export dependency specifiers from one module.
 */
function collectStaticDependencySpecifiers(ast: Program): string[] {
    const sources: string[] = [];
    for (const node of ast.body) {
        if (
            node.type === 'ImportDeclaration' &&
            !isTypeOnlyImport(node) &&
            typeof node.source.value === 'string'
        ) {
            sources.push(node.source.value);
        } else if (
            node.type === 'ExportNamedDeclaration' &&
            !isTypeOnlyExport(node) &&
            node.source &&
            typeof node.source.value === 'string'
        ) {
            sources.push(node.source.value);
        } else if (node.type === 'ExportAllDeclaration' && typeof node.source.value === 'string') {
            sources.push(node.source.value);
        }
    }
    return sources;
}

/**
 * Resolves a dependency source through Rollup and normalizes the resolved ID.
 */
async function resolveModuleId(
    ctx: PluginContext,
    importer: string,
    source: string,
    opts: { required: boolean },
): Promise<string | undefined> {
    const resolved = await ctx.resolve(source, importer, { skipSelf: false });
    if (!resolved || resolved.external) {
        if (opts.required) {
            fail(
                `Unsupported connectionId module graph in ${importer}: could not resolve local module '${source}'.`,
            );
        }
        return undefined;
    }
    return toPosix(resolved.id);
}

/**
 * Loads and parses a module, falling back to disk plus esbuild when Rollup cannot provide code.
 */
async function loadParsedModule(graph: GraphContext, id: string): Promise<ParsedModule> {
    const cached = graph.moduleCache.get(id);
    if (cached) {
        return cached;
    }

    const { code, ast } = await loadModule(graph.ctx, id);
    if (ast) {
        if (!isProgramNode(ast)) {
            throw new Error(`Expected a Program node from ctx.load() for ${id}, got ${ast.type}`);
        }
        return makeParsedModule(id, ast);
    }
    if (code === null || code === undefined) {
        fail(`Unsupported connectionId module graph in ${id}: module produced no code.`);
    }
    const parsed = graph.ctx.parse(code);
    if (!isProgramNode(parsed)) {
        throw new Error(`Expected a Program node from ctx.parse() for ${id}, got ${parsed.type}`);
    }
    return makeParsedModule(id, parsed);
}

/**
 * Loads module code from Rollup or from disk when ModuleInfo.code is unavailable.
 */
async function loadModule(
    ctx: PluginContext,
    id: string,
): Promise<{ code: string | null | undefined; ast?: AstNode | null }> {
    try {
        const loaded = await ctx.load({ id });
        if (typeof loaded === 'string') {
            return { code: loaded, ast: null };
        }
        return { code: loaded?.code, ast: loaded?.ast };
    } catch (error) {
        if (!isUnsupportedModuleInfoCodeError(error)) {
            throw error;
        }
    }

    const source = await fsp.readFile(stripQuery(id), 'utf8');
    const transformed = await transformWithEsbuild(source, stripQuery(id), {
        loader: getEsbuildLoader(id),
        sourcemap: false,
        target: 'esnext',
    });
    return { code: transformed.code, ast: null };
}

/**
 * Reports whether Rollup rejected access to ModuleInfo.code.
 */
function isUnsupportedModuleInfoCodeError(error: unknown): boolean {
    return (
        error instanceof Error &&
        error.message.includes('The "code" property of ModuleInfo is not supported')
    );
}

/**
 * Selects the esbuild loader for fallback parsing based on file extension.
 */
function getEsbuildLoader(id: string): 'js' | 'jsx' | 'ts' | 'tsx' {
    const ext = path.extname(stripQuery(id));
    if (ext === '.tsx') {
        return 'tsx';
    }
    if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
        return 'ts';
    }
    if (ext === '.jsx') {
        return 'jsx';
    }
    return 'js';
}

/**
 * Fails when a module uses dynamic local dependencies that cannot be statically traversed.
 */
function assertNoUnsupportedDynamicLocalDependencies(mod: ParsedModule): void {
    walkWithScope(mod.ast, mod.actionImports, (node) => {
        if (isDynamicImportExpression(node)) {
            const source = node.source;
            if (!source || source.type !== 'Literal' || typeof source.value !== 'string') {
                fail(
                    `Unsupported connectionId module graph in ${mod.id}: dynamic import sources must be static string literals.`,
                );
            }
            if (isLocalSourceSpecifier(source.value)) {
                fail(
                    `Unsupported connectionId module graph in ${mod.id}: dynamic import of local module '${source.value}' cannot be statically analyzed.`,
                );
            }
        }
        if (node.type === 'CallExpression' && isRequireCall(node)) {
            const source = node.arguments[0];
            if (!source || source.type !== 'Literal' || typeof source.value !== 'string') {
                fail(
                    `Unsupported connectionId module graph in ${mod.id}: dynamic require cannot be statically analyzed.`,
                );
            }
            if (isLocalSourceSpecifier(source.value)) {
                fail(
                    `Unsupported connectionId module graph in ${mod.id}: require of local module '${source.value}' cannot be statically analyzed.`,
                );
            }
        }
    });
}

/**
 * Reports whether an ESTree node is a dynamic import expression.
 */
function isDynamicImportExpression(node: Node): node is Node & { source?: Expression } {
    return node.type === 'ImportExpression';
}

/**
 * Reports whether a call expression is a CommonJS require call.
 */
function isRequireCall(node: CallExpression): boolean {
    return (
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments.length > 0
    );
}

/**
 * Collects action-catalog calls in one parsed module.
 */
function collectActionCatalogCalls(mod: ParsedModule): CallExpression[] {
    const calls: CallExpression[] = [];
    walkWithScope(mod.ast, mod.actionImports, (node, shadowedBindings) => {
        if (
            node.type === 'CallExpression' &&
            isActionCatalogCallee(node.callee, mod.actionImports, shadowedBindings)
        ) {
            calls.push(node);
        }
    });
    return calls;
}

/**
 * Extracts connection IDs from an action-catalog call using async graph-aware resolution.
 */
async function extractIdsFromActionCatalogCallAsync(
    call: CallExpression,
    mod: ParsedModule,
    graph: GraphContext,
): Promise<string[]> {
    failIfOptionalActionCatalogCall(call, mod.id);

    const firstArg = call.arguments[0];
    if (!firstArg || firstArg.type !== 'ObjectExpression') {
        fail(
            `Unsupported action-catalog call in ${mod.id}: the first argument must be an object literal so connectionId can be statically analyzed.`,
        );
    }

    const connectionIdValue = findConnectionIdValue(firstArg, mod.id);
    if (!connectionIdValue) {
        return [];
    }
    return [await resolveConnectionIdValueAsync(connectionIdValue, mod, graph, [])];
}

/**
 * Extracts connection IDs from a statically analyzable action-catalog call.
 */
function extractIdsFromActionCatalogCall(
    call: CallExpression,
    bindings: ModuleBindings,
    filePath: string,
): string[] {
    failIfOptionalActionCatalogCall(call, filePath);

    const firstArg = call.arguments[0];
    // Support `request({ connectionId: 'abc' })`; reject `request(options)`.
    if (!firstArg || firstArg.type !== 'ObjectExpression') {
        fail(
            `Unsupported action-catalog call in ${filePath}: the first argument must be an object literal so connectionId can be statically analyzed.`,
        );
    }

    const connectionIdValue = findConnectionIdValue(firstArg, filePath);
    if (!connectionIdValue) {
        return [];
    }
    // In PR #340, this same ESTree node can be an inline string
    // `{ connectionId: 'abc' }` or a same-file const like `CONNECTIONS.HTTP`.
    return [resolveConnectionIdValue(connectionIdValue, bindings, filePath)];
}

/**
 * Fails when an action-catalog call uses optional chaining that can hide the invoked callee.
 */
function failIfOptionalActionCatalogCall(call: CallExpression, filePath: string): void {
    // `request?.({ connectionId: 'abc' })` and `http?.request(...)` can hide
    // which callee is actually invoked.
    if (isOptionalNode(call) || containsOptionalMember(call.callee)) {
        fail(
            `Unsupported action-catalog call in ${filePath}: optional chaining cannot be statically analyzed for connectionId.`,
        );
    }
}

/**
 * Finds the visible connectionId property value in an object-literal call argument.
 */
function findConnectionIdValue(obj: ObjectExpression, filePath: string): Expression | undefined {
    let connectionIdValue: Expression | undefined;
    for (const prop of obj.properties) {
        // `{ connectionId: 'visible', ...opts }` can be overwritten by `opts`.
        if (prop.type === 'SpreadElement') {
            fail(
                `Unsupported action-catalog call in ${filePath}: object spreads can hide connectionId.`,
            );
        }
        // ObjectExpression also allows spread elements; only key/value
        // properties like `{ connectionId: 'abc' }` are useful here.
        if (prop.type !== 'Property') {
            continue;
        }
        // `{ ['connectionId']: 'abc' }` is intentionally rejected so the key
        // is visible without evaluating JavaScript.
        if (prop.computed) {
            fail(
                `Unsupported action-catalog call in ${filePath}: computed object keys can hide connectionId.`,
            );
        }
        // Match both `{ connectionId: 'abc' }` and `{ 'connectionId': 'abc' }`.
        if (isConnectionIdProperty(prop)) {
            if (connectionIdValue) {
                fail(
                    `Unsupported action-catalog call in ${filePath}: multiple connectionId properties cannot be statically analyzed.`,
                );
            }
            connectionIdValue = prop.value as Expression;
        }
    }
    return connectionIdValue;
}

/**
 * Reports whether an object property key is the static connectionId key.
 */
function isConnectionIdProperty(prop: Property): boolean {
    // Identifier key in `{ connectionId: 'abc' }`.
    if (prop.key.type === 'Identifier') {
        return prop.key.name === 'connectionId';
    }
    // Literal key in `{ 'connectionId': 'abc' }`.
    return prop.key.type === 'Literal' && prop.key.value === 'connectionId';
}

/**
 * Resolves a supported static connectionId expression across the module graph.
 */
async function resolveConnectionIdValueAsync(
    node: Expression,
    mod: ParsedModule,
    graph: GraphContext,
    resolutionStack: string[],
): Promise<string> {
    if (node.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
    }
    if (node.type === 'TemplateLiteral') {
        return resolveStaticTemplateLiteral(node, mod.id);
    }
    if (node.type === 'Identifier') {
        return resolveConnectionIdIdentifierAsync(node.name, mod, graph, resolutionStack);
    }
    if (node.type === 'MemberExpression') {
        return resolveConnectionIdMemberAsync(node, mod, graph, resolutionStack);
    }
    fail(
        `Unsupported connectionId expression in ${mod.id}: expected a static string literal, static template literal, const identifier, or const object member; got ${node.type}.`,
    );
}

/**
 * Resolves a supported static connectionId expression to a string.
 */
function resolveConnectionIdValue(
    node: Expression,
    bindings: ModuleBindings,
    filePath: string,
    resolutionStack: string[] = [],
): string {
    if (node.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
    }
    if (node.type === 'TemplateLiteral') {
        return resolveStaticTemplateLiteral(node, filePath);
    }
    if (node.type === 'Identifier') {
        return resolveConnectionIdIdentifier(node.name, bindings, filePath, resolutionStack);
    }
    if (node.type === 'MemberExpression') {
        return resolveConnectionIdMember(node, bindings, filePath, resolutionStack);
    }
    fail(
        `Unsupported connectionId expression in ${filePath}: expected a static string literal, static template literal, same-file const identifier, or same-file const object member; got ${node.type}.`,
    );
}

/**
 * Resolves a template literal that has no dynamic expressions.
 */
function resolveStaticTemplateLiteral(node: TemplateLiteral, filePath: string): string {
    if (node.expressions.length > 0) {
        fail(
            `Unsupported connectionId expression in ${filePath}: template literals with interpolations cannot be statically analyzed.`,
        );
    }

    const quasi = node.quasis[0];
    return quasi.value.cooked ?? quasi.value.raw;
}

/**
 * Resolves a connectionId identifier through local or imported const bindings.
 */
async function resolveConnectionIdIdentifierAsync(
    name: string,
    mod: ParsedModule,
    graph: GraphContext,
    resolutionStack: string[],
): Promise<string> {
    const mutableKind = mod.bindings.mutables.get(name);
    if (mutableKind) {
        fail(
            `Unsupported connectionId expression in ${mod.id}: '${name}' is declared with '${mutableKind}' and may be reassigned; only top-level const bindings are supported.`,
        );
    }

    const init = mod.bindings.consts.get(name);
    if (init) {
        assertResolutionStack(name, mod.id, resolutionStack);
        return resolveConnectionIdValueAsync(init, mod, graph, [...resolutionStack, name]);
    }

    const binding = mod.bindings.importBindings.get(name);
    if (binding) {
        const exported = await resolveExportedExpression(
            graph,
            mod.id,
            binding.source,
            binding.imported,
            [...resolutionStack, `${mod.id}:${name}`],
        );
        return resolveConnectionIdValueAsync(exported.expression, exported.module, graph, [
            ...resolutionStack,
            `${mod.id}:${name}`,
        ]);
    }

    fail(
        `Unsupported connectionId expression in ${mod.id}: identifier '${name}' is not a top-level const binding or resolvable import.`,
    );
}

/**
 * Resolves a connectionId identifier through same-file top-level const bindings.
 */
function resolveConnectionIdIdentifier(
    name: string,
    bindings: ModuleBindings,
    filePath: string,
    resolutionStack: string[],
): string {
    const mutableKind = bindings.mutables.get(name);
    if (mutableKind) {
        fail(
            `Unsupported connectionId expression in ${filePath}: '${name}' is declared with '${mutableKind}' and may be reassigned; only top-level const bindings are supported.`,
        );
    }
    if (bindings.importedIdentifiers.has(name) || bindings.importedNamespaces.has(name)) {
        fail(
            `Unsupported connectionId expression in ${filePath}: imported identifier '${name}' cannot be statically analyzed in this PR.`,
        );
    }

    const init = bindings.consts.get(name);
    if (!init) {
        fail(
            `Unsupported connectionId expression in ${filePath}: identifier '${name}' is not a top-level same-file const binding.`,
        );
    }
    assertResolutionStack(name, filePath, resolutionStack);

    return resolveConnectionIdValue(init, bindings, filePath, [...resolutionStack, name]);
}

/**
 * Resolves a connectionId member expression through local or imported const object members.
 */
async function resolveConnectionIdMemberAsync(
    node: MemberExpression,
    mod: ParsedModule,
    graph: GraphContext,
    resolutionStack: string[],
): Promise<string> {
    const { objectName, propertyName } = readSupportedMemberExpression(node, mod.id);
    const mutableKind = mod.bindings.mutables.get(objectName);
    if (mutableKind) {
        fail(
            `Unsupported connectionId expression in ${mod.id}: object '${objectName}' is declared with '${mutableKind}' and may be reassigned; only top-level const object literals are supported.`,
        );
    }

    const objectInit = mod.bindings.consts.get(objectName);
    if (objectInit) {
        return resolveObjectMemberValueAsync(objectInit, propertyName, mod, graph, resolutionStack);
    }

    const binding = mod.bindings.importBindings.get(objectName);
    if (binding) {
        const exported = await resolveExportedExpression(
            graph,
            mod.id,
            binding.source,
            binding.imported,
            [...resolutionStack, `${mod.id}:${objectName}`],
        );
        return resolveObjectMemberValueAsync(
            exported.expression,
            propertyName,
            exported.module,
            graph,
            [...resolutionStack, `${mod.id}:${objectName}`],
        );
    }

    fail(
        `Unsupported connectionId expression in ${mod.id}: object '${objectName}' is not a top-level const binding or resolvable import.`,
    );
}

/**
 * Resolves a connectionId member expression through same-file const object members.
 */
function resolveConnectionIdMember(
    node: MemberExpression,
    bindings: ModuleBindings,
    filePath: string,
    resolutionStack: string[],
): string {
    const { objectName, propertyName } = readSupportedMemberExpression(node, filePath);
    const mutableKind = bindings.mutables.get(objectName);
    if (mutableKind) {
        fail(
            `Unsupported connectionId expression in ${filePath}: object '${objectName}' is declared with '${mutableKind}' and may be reassigned; only top-level const object literals are supported.`,
        );
    }
    if (
        bindings.importedIdentifiers.has(objectName) ||
        bindings.importedNamespaces.has(objectName)
    ) {
        fail(
            `Unsupported connectionId expression in ${filePath}: imported object '${objectName}' cannot be statically analyzed in this PR.`,
        );
    }

    const objectInit = bindings.consts.get(objectName);
    if (!objectInit) {
        fail(
            `Unsupported connectionId expression in ${filePath}: object '${objectName}' is not a top-level same-file const binding.`,
        );
    }
    if (objectInit.type !== 'ObjectExpression') {
        fail(
            `Unsupported connectionId expression in ${filePath}: object '${objectName}' must be initialized to an object literal.`,
        );
    }

    return resolveObjectMemberValue(objectInit, propertyName, bindings, filePath, resolutionStack);
}

/**
 * Reads and validates the object and property names from a supported member expression.
 */
function readSupportedMemberExpression(
    node: MemberExpression,
    filePath: string,
): { objectName: string; propertyName: string } {
    if (node.computed) {
        fail(
            `Unsupported connectionId expression in ${filePath}: computed member expressions cannot be statically analyzed.`,
        );
    }
    if (node.object.type !== 'Identifier') {
        fail(
            `Unsupported connectionId expression in ${filePath}: nested or non-static member expressions cannot be statically analyzed.`,
        );
    }

    const propertyName = readStaticPropertyName(node.property);
    if (!propertyName) {
        fail(
            `Unsupported connectionId expression in ${filePath}: member property must be a static identifier.`,
        );
    }
    return { objectName: node.object.name, propertyName };
}

/**
 * Resolves one static property from a graph-resolved object expression.
 */
async function resolveObjectMemberValueAsync(
    objectExpression: Expression,
    propertyName: string,
    mod: ParsedModule,
    graph: GraphContext,
    resolutionStack: string[],
): Promise<string> {
    if (objectExpression.type === 'Identifier') {
        return resolveConnectionIdMemberAsync(
            {
                type: 'MemberExpression',
                object: objectExpression,
                property: { type: 'Identifier', name: propertyName },
                computed: false,
                optional: false,
            } as MemberExpression,
            mod,
            graph,
            resolutionStack,
        );
    }
    if (objectExpression.type !== 'ObjectExpression') {
        fail(
            `Unsupported connectionId expression in ${mod.id}: object member must resolve to an object literal.`,
        );
    }

    const value = findStaticObjectMemberValue(objectExpression, propertyName, mod.id);
    return resolveConnectionIdValueAsync(value, mod, graph, resolutionStack);
}

/**
 * Resolves one static property from a const object expression.
 */
function resolveObjectMemberValue(
    objectExpression: Expression,
    propertyName: string,
    bindings: ModuleBindings,
    filePath: string,
    resolutionStack: string[],
): string {
    if (objectExpression.type !== 'ObjectExpression') {
        fail(
            `Unsupported connectionId expression in ${filePath}: object '${objectExpression.type === 'Identifier' ? objectExpression.name : 'value'}' must be initialized to an object literal.`,
        );
    }

    const value = findStaticObjectMemberValue(objectExpression, propertyName, filePath);
    return resolveConnectionIdValue(value, bindings, filePath, resolutionStack);
}

/**
 * Finds a static property value inside an object expression.
 */
function findStaticObjectMemberValue(
    objectExpression: ObjectExpression,
    propertyName: string,
    filePath: string,
): Expression {
    let value: Expression | undefined;

    for (const prop of objectExpression.properties) {
        if (prop.type === 'SpreadElement') {
            fail(
                `Unsupported connectionId expression in ${filePath}: object spreads can hide connectionId object members.`,
            );
        }
        if (prop.type !== 'Property') {
            continue;
        }
        if (prop.computed) {
            fail(
                `Unsupported connectionId expression in ${filePath}: computed object properties can hide connectionId object members.`,
            );
        }

        const key = readStaticPropertyName(prop.key);
        if (key !== propertyName) {
            continue;
        }
        if (value) {
            fail(
                `Unsupported connectionId expression in ${filePath}: object member '${propertyName}' is defined multiple times.`,
            );
        }
        value = prop.value as Expression;
    }

    if (!value) {
        fail(
            `Unsupported connectionId expression in ${filePath}: object has no static '${propertyName}' property.`,
        );
    }

    return value;
}

/**
 * Resolves an exported expression from another module in the graph.
 */
async function resolveExportedExpression(
    graph: GraphContext,
    importer: string,
    source: string,
    exportName: string,
    resolutionStack: string[],
): Promise<{ module: ParsedModule; expression: Expression }> {
    const key = `${importer}::${source}::${exportName}`;
    assertResolutionStack(key, importer, resolutionStack);

    const resolvedId = await resolveModuleId(graph.ctx, importer, source, { required: true });
    if (!resolvedId) {
        fail(
            `Unsupported connectionId expression in ${importer}: could not resolve imported value '${exportName}' from '${source}'.`,
        );
    }
    if (!shouldTraverseResolvedId(resolvedId, graph.buildRoot)) {
        fail(
            `Unsupported connectionId expression in ${importer}: imported value '${exportName}' from '${source}' resolves outside the analyzable module graph.`,
        );
    }

    const target = await loadParsedModule(graph, resolvedId);
    const nextStack = [...resolutionStack, key];
    const mutableKind = target.bindings.mutables.get(exportName);
    if (mutableKind) {
        fail(
            `Unsupported connectionId expression in ${target.id}: '${exportName}' is declared with '${mutableKind}' and may be reassigned; only top-level const bindings are supported.`,
        );
    }
    const localConst = target.bindings.consts.get(exportName);
    if (localConst) {
        return { module: target, expression: localConst };
    }

    for (const node of target.ast.body) {
        if (node.type === 'ExportNamedDeclaration') {
            if (isTypeOnlyExport(node)) {
                continue;
            }
            const found = await resolveNamedExportDeclaration(
                graph,
                target,
                node,
                exportName,
                nextStack,
            );
            if (found) {
                return found;
            }
        } else if (
            node.type === 'ExportAllDeclaration' &&
            typeof node.source.value === 'string' &&
            !node.exported
        ) {
            try {
                return await resolveExportedExpression(
                    graph,
                    target.id,
                    node.source.value,
                    exportName,
                    nextStack,
                );
            } catch (error) {
                if (error instanceof ExportNotFoundError) {
                    continue;
                }
                throw error;
            }
        }
    }

    throw new ExportNotFoundError(
        `[connectionId manifest] export '${exportName}' not found in '${target.id}' while resolving connectionId`,
    );
}

/**
 * Resolves one named export declaration to the expression it exports.
 */
async function resolveNamedExportDeclaration(
    graph: GraphContext,
    target: ParsedModule,
    node: ExportNamedDeclaration,
    exportName: string,
    resolutionStack: string[],
): Promise<{ module: ParsedModule; expression: Expression } | undefined> {
    if (node.source && typeof node.source.value === 'string') {
        for (const spec of node.specifiers) {
            const exportedName = readExportedName(spec.exported);
            if (exportedName !== exportName) {
                continue;
            }
            return resolveExportedExpression(
                graph,
                target.id,
                node.source.value,
                readExportedName(spec.local),
                resolutionStack,
            );
        }
        return undefined;
    }

    for (const spec of node.specifiers) {
        const exportedName = readExportedName(spec.exported);
        if (exportedName !== exportName) {
            continue;
        }
        const localName = readExportedName(spec.local);
        const localConst = target.bindings.consts.get(localName);
        if (localConst) {
            return { module: target, expression: localConst };
        }
        const binding = target.bindings.importBindings.get(localName);
        if (binding) {
            return resolveExportedExpression(
                graph,
                target.id,
                binding.source,
                binding.imported,
                resolutionStack,
            );
        }
        return {
            module: target,
            expression: { type: 'Identifier', name: localName } as Expression,
        };
    }

    if (node.declaration?.type === 'VariableDeclaration') {
        if (node.declaration.kind !== 'const') {
            fail(
                `Unsupported connectionId expression in ${target.id}: '${exportName}' is declared with '${node.declaration.kind}' and may be reassigned; only top-level const bindings are supported.`,
            );
        }
        for (const declaration of node.declaration.declarations) {
            if (declaration.id.type === 'Identifier' && declaration.id.name === exportName) {
                if (!declaration.init) {
                    break;
                }
                return { module: target, expression: declaration.init };
            }
        }
    }

    return undefined;
}

/**
 * Reads the string name represented by an export specifier node.
 */
function readExportedName(node: Node): string {
    if (node.type === 'Identifier') {
        return node.name;
    }
    if (node.type === 'Literal') {
        return String(node.value);
    }
    return '';
}

/**
 * Fails on cyclic or excessively deep const/import resolution chains.
 */
function assertResolutionStack(name: string, filePath: string, resolutionStack: string[]): void {
    if (resolutionStack.includes(name)) {
        fail(
            `Unsupported connectionId expression in ${filePath}: cyclic const connectionId reference '${[
                ...resolutionStack,
                name,
            ].join(' -> ')}'.`,
        );
    }
    if (resolutionStack.length >= MAX_CONST_RESOLUTION_DEPTH) {
        fail(
            `Unsupported connectionId expression in ${filePath}: const/import connectionId reference chain is too deep.`,
        );
    }
}

/**
 * Reads a property name when the ESTree property key is statically known.
 */
function readStaticPropertyName(node: Node): string | undefined {
    if (node.type === 'Identifier') {
        return node.name;
    }
    if (node.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
    }
    return undefined;
}

/**
 * Reports whether a call expression callee resolves directly to an action-catalog import.
 */
function isActionCatalogCallee(
    callee: Expression | Super,
    imports: ActionCatalogImports,
    shadowedBindings: Set<string>,
): boolean {
    // Named/default import call: `request({ connectionId: 'abc' })`.
    if (callee.type === 'Identifier') {
        return imports.functions.has(callee.name) && !shadowedBindings.has(callee.name);
    }
    // Namespace import call: `http.request({ connectionId: 'abc' })`.
    if (callee.type !== 'MemberExpression') {
        return false;
    }
    return isNamespaceMember(callee, imports.namespaces, shadowedBindings);
}

/**
 * Fails on action-catalog call shapes the extractor intentionally cannot analyze.
 */
function failIfUnsupportedActionCatalogUsage(
    call: CallExpression,
    imports: ActionCatalogImports,
    shadowedBindings: Set<string>,
    filePath: string,
): void {
    const { callee } = call;
    // Unsupported alias call: `const action = request; action(...)`.
    if (
        callee.type === 'Identifier' &&
        imports.unsupportedAliases.has(callee.name) &&
        !shadowedBindings.has(callee.name)
    ) {
        fail(
            `Unsupported action-catalog call in ${filePath}: action-catalog call aliases cannot be statically analyzed for connectionId.`,
        );
    }
    // Unsupported computed namespace call: `http['request'](...)`.
    if (
        callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        imports.namespaces.has(callee.object.name) &&
        !shadowedBindings.has(callee.object.name) &&
        callee.computed
    ) {
        fail(
            `Unsupported action-catalog call in ${filePath}: computed namespace member calls cannot be statically analyzed for connectionId.`,
        );
    }
    for (const arg of call.arguments) {
        if (
            arg.type === 'Identifier' &&
            imports.functions.has(arg.name) &&
            !shadowedBindings.has(arg.name)
        ) {
            fail(
                `Unsupported action-catalog call in ${filePath}: higher-order action-catalog invocation cannot be statically analyzed for connectionId.`,
            );
        }
        if (
            arg.type === 'Identifier' &&
            imports.namespaces.has(arg.name) &&
            !shadowedBindings.has(arg.name)
        ) {
            fail(
                `Unsupported action-catalog call in ${filePath}: higher-order action-catalog invocation cannot be statically analyzed for connectionId.`,
            );
        }
    }
}

/**
 * Reports whether a member expression is a direct access on an action-catalog namespace import.
 */
function isNamespaceMember(
    member: MemberExpression,
    namespaces: Set<string>,
    shadowedBindings: Set<string>,
): boolean {
    return (
        // `http.request(...)` where `http` came from `import * as http`.
        member.object.type === 'Identifier' &&
        namespaces.has(member.object.name) &&
        !shadowedBindings.has(member.object.name) &&
        // The member must be statically named, unlike `http[actionName](...)`.
        member.property.type === 'Identifier' &&
        !member.computed
    );
}

/**
 * Recursively reports whether a callee member chain includes optional access.
 */
function containsOptionalMember(node: Node): boolean {
    // Finds optional access in callees like `http?.request(...)`.
    if (node.type === 'MemberExpression') {
        return isOptionalNode(node) || containsOptionalMember(node.object);
    }
    return false;
}

/**
 * Reads the optional flag that ESTree parsers attach to optional call/member nodes.
 */
function isOptionalNode(node: Node): boolean {
    return (node as Node & { optional?: boolean }).optional === true;
}

/**
 * Walks an ESTree subtree while tracking local bindings that shadow action-catalog imports.
 *
 * For example, given:
 *
 * ```ts
 * import { request } from '@datadog/action-catalog/http/http';
 * request({ connectionId: 'real-action' });
 * export function run(request) {
 *     request({ connectionId: 'local-param' });
 * }
 * ```
 *
 * The visitor sees the top-level `request(...)` with an empty shadow set, so it can be treated as
 * the imported action. Inside `run`, the function parameter shadows the import, so the visitor sees
 * `shadowedBindings.has('request') === true` and ignores that local call.
 */
function walkWithScope(
    node: Node,
    imports: ActionCatalogImports,
    visit: (node: Node, shadowedBindings: Set<string>) => void,
    shadowedBindings = new Set<string>(),
): void {
    visit(node, shadowedBindings);

    // Module body for source like `import ...; export function run() {}`.
    if (node.type === 'Program') {
        for (const statement of node.body) {
            walkWithScope(statement, imports, visit, shadowedBindings);
        }
        return;
    }
    // Block scope for `{ const request = localClient; request(...) }`.
    if (node.type === 'BlockStatement') {
        const blockScope = new Set(shadowedBindings);
        collectShadowingDeclarations(node.body, imports, blockScope);
        for (const statement of node.body) {
            walkWithScope(statement, imports, visit, blockScope);
        }
        return;
    }
    // Function parameters can shadow action imports:
    // `function run(request) { request({ connectionId: 'local' }) }`.
    if (
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression'
    ) {
        const functionScope = new Set(shadowedBindings);
        for (const param of node.params) {
            addShadowedPatternBindings(param, imports, functionScope);
        }
        walkWithScope(node.body, imports, visit, functionScope);
        return;
    }
    // Catch parameters can shadow imports:
    // `catch (request) { request({ connectionId: 'local' }) }`.
    if (node.type === 'CatchClause') {
        const catchScope = new Set(shadowedBindings);
        if (node.param) {
            addShadowedPatternBindings(node.param, imports, catchScope);
        }
        walkWithScope(node.body, imports, visit, catchScope);
        return;
    }

    for (const value of Object.values(node as unknown as Record<string, unknown>)) {
        if (Array.isArray(value)) {
            for (const child of value) {
                if (isNode(child)) {
                    walkWithScope(child, imports, visit, shadowedBindings);
                }
            }
        } else if (isNode(value)) {
            walkWithScope(value, imports, visit, shadowedBindings);
        }
    }
}

/**
 * Adds block-scoped declarations that shadow tracked action-catalog names.
 */
function collectShadowingDeclarations(
    statements: Statement[],
    imports: ActionCatalogImports,
    shadowedBindings: Set<string>,
): void {
    for (const statement of statements) {
        if (statement.type === 'VariableDeclaration') {
            for (const declaration of statement.declarations) {
                // Preserve action aliases like `const action = request` as
                // unsupported aliases instead of treating them as local shadowing.
                if (isActionCatalogAliasDeclaration(declaration, imports, shadowedBindings)) {
                    continue;
                }
                addShadowedPatternBindings(declaration.id, imports, shadowedBindings);
            }
            // `function request() {}` shadows an imported `request` inside the block.
        } else if (statement.type === 'FunctionDeclaration' && statement.id) {
            addShadowedBinding(statement.id.name, imports, shadowedBindings);
            // `class http {}` shadows an imported namespace named `http`.
        } else if (statement.type === 'ClassDeclaration' && statement.id) {
            addShadowedBinding(statement.id.name, imports, shadowedBindings);
        }
    }
}

/**
 * Reports whether a variable declarator creates an unsupported alias of an action-catalog call.
 */
function isActionCatalogAliasDeclaration(
    declaration: VariableDeclarator,
    imports: ActionCatalogImports,
    shadowedBindings: Set<string>,
): boolean {
    // `const action = request`
    if (
        declaration.id.type === 'Identifier' &&
        declaration.init?.type === 'Identifier' &&
        imports.functions.has(declaration.init.name) &&
        !shadowedBindings.has(declaration.init.name)
    ) {
        return true;
    }
    // `const action = http.request`
    if (
        declaration.id.type === 'Identifier' &&
        declaration.init?.type === 'MemberExpression' &&
        isNamespaceMember(declaration.init, imports.namespaces, shadowedBindings)
    ) {
        return true;
    }
    // `const { request: action } = http`
    return (
        declaration.id.type === 'ObjectPattern' &&
        declaration.init?.type === 'Identifier' &&
        imports.namespaces.has(declaration.init.name) &&
        !shadowedBindings.has(declaration.init.name)
    );
}

/**
 * Adds every identifier introduced by a binding pattern to the current shadowing set.
 */
function addShadowedPatternBindings(
    pattern: Node,
    imports: ActionCatalogImports,
    shadowedBindings: Set<string>,
): void {
    for (const name of getPatternBindingNames(pattern)) {
        addShadowedBinding(name, imports, shadowedBindings);
    }
}

/**
 * Adds a local binding name when it shadows an action-catalog import or alias.
 */
function addShadowedBinding(
    name: string,
    imports: ActionCatalogImports,
    shadowedBindings: Set<string>,
): void {
    if (
        imports.functions.has(name) ||
        imports.namespaces.has(name) ||
        imports.unsupportedAliases.has(name)
    ) {
        shadowedBindings.add(name);
    }
}

/**
 * Returns the identifier names declared by an ESTree binding pattern.
 */
function getPatternBindingNames(pattern: Node): string[] {
    // `request` in `function run(request) {}` or `const request = client`.
    if (pattern.type === 'Identifier') {
        return [pattern.name];
    }
    // `rest` in `const { ...rest } = value`.
    if (pattern.type === 'RestElement') {
        return getPatternBindingNames(pattern.argument);
    }
    // `request` in `function run(request = client) {}`.
    if (pattern.type === 'AssignmentPattern') {
        return getPatternBindingNames(pattern.left);
    }
    // `request` in `const [request] = clients`.
    if (pattern.type === 'ArrayPattern') {
        return pattern.elements.flatMap((element) =>
            element ? getPatternBindingNames(element) : [],
        );
    }
    // `request` in `const { client: request } = clients`.
    if (pattern.type === 'ObjectPattern') {
        return pattern.properties.flatMap((prop) => {
            if (prop.type === 'RestElement') {
                return getPatternBindingNames(prop.argument);
            }
            return getPatternBindingNames(prop.value as Node);
        });
    }
    return [];
}

/**
 * Reports whether an unknown value looks like an ESTree node.
 */
function isNode(value: unknown): value is Node {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { type?: unknown }).type === 'string'
    );
}

/**
 * Throws a consistently prefixed extraction error.
 */
function fail(message: string): never {
    throw new ConnectionIdExtractionError(`[connectionId manifest] ${message}`);
}
