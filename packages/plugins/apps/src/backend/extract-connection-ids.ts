// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { walk } from 'estree-walker';
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
    TemplateLiteral,
} from 'estree';
import fsp from 'fs/promises';
import path from 'path';
import type { AstNode, PluginContext } from 'rollup';
import { transformWithEsbuild } from 'vite';

import { enumerateBackendExports } from './discovery';

const MAX_HOPS = 32;
const ACTION_CATALOG_PACKAGE = '@datadog/action-catalog';
const GENERATED_SEGMENT_RE = /[/\\](?:dist|build|\.vite)(?:[/\\]|$)/;

type MutableKind = 'let' | 'var';

type ImportBinding = {
    source: string;
    imported: string;
};

type LocalSymbols = {
    localConsts: Map<string, Expression>;
    localMutables: Map<string, { kind: MutableKind; loc: Node['loc'] }>;
    importBindings: Map<string, ImportBinding>;
    namespaceImports: Map<string, string>;
    actionFunctions: Set<string>;
    actionNamespaces: Set<string>;
};

type ParsedModule = {
    id: string;
    ast: Program;
    symbols: LocalSymbols;
};

type ResolutionState = {
    visited: Set<string>;
    hops: number;
    originFile: string;
    label: string;
};

type ConnectionIdCallSite = {
    module: ParsedModule;
    valueNode: Expression;
    loc: Node['loc'];
};

class ExtractionError extends Error {}

class ExportNotFoundError extends ExtractionError {}

/**
 * Statically extract every action-catalog `connectionId` used by the local
 * module graph reachable from one `*.backend.*` entry file.
 *
 * The result is intentionally file-level: every supported backend export in the
 * entry file receives the same sorted allowlist. This mirrors the conservative
 * module-graph design: if a reachable helper module contains an action call, any
 * export from the backend entry may be able to reach it at runtime.
 */
export async function extractConnectionIds(
    ctx: PluginContext,
    ast: AstNode,
    filePath: string,
    buildRoot = path.dirname(filePath),
): Promise<Map<string, string[]>> {
    const bindings = enumerateBackendExports(ast, filePath);
    if (!isProgram(ast)) {
        throw new Error(`Expected a Program node from this.parse() for ${filePath}`);
    }

    const modules = await buildReachableModuleGraph(ctx, ast, filePath, buildRoot);
    const ids = new Set<string>();

    for (const mod of modules) {
        for (const callSite of findConnectionIdCallSites(mod)) {
            ids.add(
                await resolveValue(ctx, callSite.valueNode, callSite.module, {
                    visited: new Set(),
                    hops: 0,
                    originFile: filePath,
                    label: 'module graph',
                }),
            );
        }
    }

    const sortedIds = [...ids].sort();
    return new Map(bindings.map((binding) => [binding.name, sortedIds]));
}

function isProgram(node: AstNode): node is AstNode & Program {
    return node.type === 'Program';
}

function isMutableKind(kind: string): kind is MutableKind {
    return kind === 'let' || kind === 'var';
}

function isTypeOnlyImport(node: ImportDeclaration): boolean {
    return (node as ImportDeclaration & { importKind?: string }).importKind === 'type';
}

function isTypeOnlyImportSpecifier(node: ImportSpecifier): boolean {
    return (node as ImportSpecifier & { importKind?: string }).importKind === 'type';
}

function isTypeOnlyExport(node: ExportNamedDeclaration): boolean {
    return (node as ExportNamedDeclaration & { exportKind?: string }).exportKind === 'type';
}

function isActionCatalogSource(source: string): boolean {
    return source === ACTION_CATALOG_PACKAGE || source.startsWith(`${ACTION_CATALOG_PACKAGE}/`);
}

function isLocalSourceSpecifier(source: string): boolean {
    return source.startsWith('.') || source.startsWith('/');
}

function stripQuery(id: string): string {
    return id.replace(/\?.*$/, '');
}

function toPosix(id: string): string {
    return id.split(path.sep).join('/');
}

function isInsideBuildRoot(id: string, buildRoot: string): boolean {
    const rel = path.relative(buildRoot, stripQuery(id));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isGeneratedOutput(id: string): boolean {
    return GENERATED_SEGMENT_RE.test(stripQuery(id));
}

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

function buildSymbolTable(ast: Program): LocalSymbols {
    const localConsts = new Map<string, Expression>();
    const localMutables = new Map<string, { kind: MutableKind; loc: Node['loc'] }>();
    const importBindings = new Map<string, ImportBinding>();
    const namespaceImports = new Map<string, string>();
    const actionFunctions = new Set<string>();
    const actionNamespaces = new Set<string>();

    const recordVariableDeclaration = (decl: {
        kind: string;
        declarations: Array<{
            id: Node;
            init?: Expression | null;
        }>;
    }): void => {
        for (const d of decl.declarations) {
            if (d.id.type !== 'Identifier') {
                continue;
            }
            if (decl.kind === 'const' && d.init) {
                localConsts.set(d.id.name, d.init);
            } else if (isMutableKind(decl.kind)) {
                localMutables.set(d.id.name, { kind: decl.kind, loc: d.id.loc ?? null });
            }
        }
    };

    for (const node of ast.body) {
        if (node.type === 'VariableDeclaration') {
            recordVariableDeclaration(node);
        } else if (
            node.type === 'ExportNamedDeclaration' &&
            node.declaration?.type === 'VariableDeclaration'
        ) {
            recordVariableDeclaration(node.declaration);
        } else if (
            node.type === 'ImportDeclaration' &&
            !isTypeOnlyImport(node) &&
            typeof node.source.value === 'string'
        ) {
            const source = node.source.value;
            for (const spec of node.specifiers) {
                if (spec.type === 'ImportSpecifier') {
                    if (isTypeOnlyImportSpecifier(spec)) {
                        continue;
                    }
                    const imported =
                        spec.imported.type === 'Identifier'
                            ? spec.imported.name
                            : String(spec.imported.value);
                    if (isActionCatalogSource(source)) {
                        actionFunctions.add(spec.local.name);
                    } else {
                        importBindings.set(spec.local.name, { source, imported });
                    }
                } else if (spec.type === 'ImportDefaultSpecifier') {
                    if (isActionCatalogSource(source)) {
                        actionFunctions.add(spec.local.name);
                    } else {
                        importBindings.set(spec.local.name, { source, imported: 'default' });
                    }
                } else if (spec.type === 'ImportNamespaceSpecifier') {
                    if (isActionCatalogSource(source)) {
                        actionNamespaces.add(spec.local.name);
                    } else {
                        namespaceImports.set(spec.local.name, source);
                    }
                }
            }
        }
    }

    return {
        localConsts,
        localMutables,
        importBindings,
        namespaceImports,
        actionFunctions,
        actionNamespaces,
    };
}

async function buildReachableModuleGraph(
    ctx: PluginContext,
    entryAst: Program,
    entryId: string,
    buildRoot: string,
): Promise<ParsedModule[]> {
    const normalizedBuildRoot = stripQuery(buildRoot);
    const cache = new Map<string, ParsedModule>();
    const ordered: ParsedModule[] = [];
    const queue: ParsedModule[] = [];

    const entry = makeParsedModule(entryId, entryAst);
    cache.set(entryId, entry);
    ordered.push(entry);
    queue.push(entry);

    for (let i = 0; i < queue.length; i += 1) {
        const mod = queue[i];
        assertNoUnsupportedDynamicLocalDependencies(mod);

        for (const source of collectStaticDependencySpecifiers(mod.ast)) {
            if (isActionCatalogSource(source)) {
                continue;
            }
            const resolvedId = await resolveModuleId(ctx, mod.id, source, {
                required: isLocalSourceSpecifier(source),
            });
            if (!resolvedId || !shouldTraverseResolvedId(resolvedId, normalizedBuildRoot)) {
                continue;
            }
            if (cache.has(resolvedId)) {
                continue;
            }
            const loaded = await loadParsedModule(ctx, resolvedId);
            cache.set(resolvedId, loaded);
            ordered.push(loaded);
            queue.push(loaded);
        }
    }

    return ordered;
}

function makeParsedModule(id: string, ast: Program): ParsedModule {
    return { id: toPosix(id), ast, symbols: buildSymbolTable(ast) };
}

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

async function resolveModuleId(
    ctx: PluginContext,
    importer: string,
    source: string,
    opts: { required: boolean },
): Promise<string | undefined> {
    const resolved = await ctx.resolve(source, importer, { skipSelf: false });
    if (!resolved || resolved.external) {
        if (opts.required) {
            throw new ExtractionError(
                `[connectionId manifest] could not resolve local module '${source}' imported from ${importer}`,
            );
        }
        return undefined;
    }
    return toPosix(resolved.id);
}

async function loadParsedModule(ctx: PluginContext, id: string): Promise<ParsedModule> {
    const { code, ast: loadedAst } = await loadModule(ctx, id);
    if (code === null || code === undefined) {
        throw new ExtractionError(
            `[connectionId manifest] module '${id}' produced no code during module graph analysis`,
        );
    }
    const ast = (loadedAst || ctx.parse(code)) as unknown as Program;
    return makeParsedModule(id, ast);
}

async function loadModule(
    ctx: PluginContext,
    id: string,
): Promise<{ code: string | null | undefined; ast?: AstNode | null }> {
    try {
        const loaded = await ctx.load({ id });
        if (typeof loaded === 'string') {
            return { code: loaded, ast: null };
        }
        return { code: loaded.code, ast: loaded.ast };
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

function isUnsupportedModuleInfoCodeError(error: unknown): boolean {
    return (
        error instanceof Error &&
        error.message.includes('The "code" property of ModuleInfo is not supported')
    );
}

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

function assertNoUnsupportedDynamicLocalDependencies(mod: ParsedModule): void {
    walk(mod.ast, {
        enter(node) {
            if (isDynamicImportExpression(node)) {
                const source = node.source;
                if (!source || source.type !== 'Literal' || typeof source.value !== 'string') {
                    failBase(
                        `dynamic import in ${mod.id} cannot be statically analyzed for backend connection IDs`,
                        node.loc,
                        mod.id,
                    );
                }
                if (isLocalSourceSpecifier(source.value)) {
                    failBase(
                        `dynamic import of local module '${source.value}' in ${mod.id} cannot be statically analyzed for backend connection IDs`,
                        node.loc,
                        mod.id,
                    );
                }
            }
            if (node.type === 'CallExpression' && isRequireCall(node)) {
                const source = node.arguments[0];
                if (!source || source.type !== 'Literal' || typeof source.value !== 'string') {
                    failBase(
                        `dynamic require in ${mod.id} cannot be statically analyzed for backend connection IDs`,
                        node.loc,
                        mod.id,
                    );
                }
                if (isLocalSourceSpecifier(source.value)) {
                    failBase(
                        `require of local module '${source.value}' in ${mod.id} cannot be statically analyzed for backend connection IDs`,
                        node.loc,
                        mod.id,
                    );
                }
            }
        },
    });
}

function isDynamicImportExpression(node: Node): node is Node & { source?: Expression } {
    return (node as { type: string }).type === 'ImportExpression';
}

function isRequireCall(node: CallExpression): boolean {
    return (
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments.length > 0
    );
}

function findConnectionIdCallSites(mod: ParsedModule): ConnectionIdCallSite[] {
    const callSites: ConnectionIdCallSite[] = [];
    walk(mod.ast, {
        enter(node) {
            if (
                node.type !== 'CallExpression' ||
                !isActionCatalogCallee(node.callee, mod.symbols)
            ) {
                return;
            }
            const firstArg = node.arguments[0];
            if (!firstArg || firstArg.type !== 'ObjectExpression') {
                return;
            }
            const prop = findConnectionIdProp(firstArg);
            if (!prop) {
                return;
            }
            callSites.push({
                module: mod,
                valueNode: prop.value as Expression,
                loc: prop.loc ?? null,
            });
        },
    });
    return callSites;
}

function isActionCatalogCallee(callee: Node, symbols: LocalSymbols): boolean {
    if (callee.type === 'Identifier') {
        return symbols.actionFunctions.has(callee.name);
    }
    if (callee.type !== 'MemberExpression') {
        return false;
    }
    const root = getMemberRoot(callee);
    return root ? symbols.actionNamespaces.has(root.name) : false;
}

function getMemberRoot(member: MemberExpression): { name: string } | undefined {
    let current = member.object;
    while (current.type === 'MemberExpression') {
        current = current.object;
    }
    return current.type === 'Identifier' ? current : undefined;
}

function findConnectionIdProp(obj: ObjectExpression): Property | undefined {
    for (const prop of obj.properties) {
        if (prop.type !== 'Property' || prop.computed) {
            continue;
        }
        if (prop.key.type === 'Identifier' && prop.key.name === 'connectionId') {
            return prop;
        }
        if (prop.key.type === 'Literal' && prop.key.value === 'connectionId') {
            return prop;
        }
    }
    return undefined;
}

async function resolveValue(
    ctx: PluginContext,
    node: Expression,
    mod: ParsedModule,
    state: ResolutionState,
): Promise<string> {
    if (node.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
    }
    if (node.type === 'TemplateLiteral') {
        return requireStaticTemplate(node, state, node.loc);
    }
    if (node.type === 'Identifier') {
        return resolveIdentifier(ctx, node.name, mod, state, node.loc);
    }
    if (node.type === 'MemberExpression') {
        return resolveMemberExpression(ctx, node, mod, state);
    }
    fail(
        state,
        `'connectionId' must be a static string, static template, const identifier, or object member; got ${node.type}`,
        node.loc,
    );
}

function requireStaticTemplate(
    node: TemplateLiteral,
    state: ResolutionState,
    loc: Node['loc'],
): string {
    if (node.expressions.length > 0) {
        fail(state, `'connectionId' template literals must not contain interpolations`, loc);
    }
    const quasi = node.quasis[0];
    return quasi.value.cooked ?? quasi.value.raw;
}

async function resolveIdentifier(
    ctx: PluginContext,
    name: string,
    mod: ParsedModule,
    state: ResolutionState,
    loc: Node['loc'],
): Promise<string> {
    const mutable = mod.symbols.localMutables.get(name);
    if (mutable) {
        fail(
            state,
            `'connectionId' must resolve to a 'const' binding; '${name}' is declared with '${mutable.kind}' and can be reassigned`,
            loc,
        );
    }
    const localInit = mod.symbols.localConsts.get(name);
    if (localInit) {
        return resolveValue(ctx, localInit, mod, state);
    }
    const binding = mod.symbols.importBindings.get(name);
    if (binding) {
        return resolveExportedValue(ctx, mod.id, binding.source, binding.imported, state);
    }
    fail(state, `identifier '${name}' is not defined in ${mod.id} and is not imported`, loc);
}

async function resolveMemberExpression(
    ctx: PluginContext,
    node: MemberExpression,
    mod: ParsedModule,
    state: ResolutionState,
): Promise<string> {
    if (node.computed) {
        fail(state, `'connectionId' computed member expressions are not supported`, node.loc);
    }
    if (node.object.type !== 'Identifier') {
        fail(state, `'connectionId' member expressions must read from a const object`, node.loc);
    }
    const propertyName = readPropertyName(node.property);
    if (!propertyName) {
        fail(state, `'connectionId' member property must be static`, node.property.loc);
    }

    const objectName = node.object.name;
    const mutable = mod.symbols.localMutables.get(objectName);
    if (mutable) {
        fail(
            state,
            `'connectionId' object '${objectName}' must resolve to a 'const' binding; it is declared with '${mutable.kind}'`,
            node.object.loc,
        );
    }
    const localInit = mod.symbols.localConsts.get(objectName);
    if (localInit) {
        return resolveObjectMember(ctx, localInit, mod, propertyName, state, node.loc);
    }
    const binding = mod.symbols.importBindings.get(objectName);
    if (binding) {
        const exported = await resolveExportedExpression(
            ctx,
            mod.id,
            binding.source,
            binding.imported,
            state,
        );
        return resolveObjectMember(
            ctx,
            exported.expression,
            exported.module,
            propertyName,
            state,
            node.loc,
        );
    }
    fail(state, `connectionId object '${objectName}' is not defined in ${mod.id}`, node.object.loc);
}

function readPropertyName(node: Node): string | undefined {
    if (node.type === 'Identifier') {
        return node.name;
    }
    if (node.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
    }
    return undefined;
}

async function resolveObjectMember(
    ctx: PluginContext,
    expression: Expression,
    mod: ParsedModule,
    propertyName: string,
    state: ResolutionState,
    loc: Node['loc'],
): Promise<string> {
    if (expression.type === 'Identifier') {
        const binding = mod.symbols.importBindings.get(expression.name);
        if (binding) {
            const exported = await resolveExportedExpression(
                ctx,
                mod.id,
                binding.source,
                binding.imported,
                state,
            );
            return resolveObjectMember(
                ctx,
                exported.expression,
                exported.module,
                propertyName,
                state,
                loc,
            );
        }
        const localInit = mod.symbols.localConsts.get(expression.name);
        if (localInit) {
            return resolveObjectMember(ctx, localInit, mod, propertyName, state, loc);
        }
    }
    if (expression.type !== 'ObjectExpression') {
        fail(state, `'connectionId' object member must resolve to an object literal`, loc);
    }

    for (const prop of expression.properties) {
        if (prop.type === 'SpreadElement') {
            fail(state, `'connectionId' object spreads are not supported`, prop.loc);
        }
        if (prop.computed) {
            fail(state, `'connectionId' object computed properties are not supported`, prop.loc);
        }
        const key = readPropertyName(prop.key);
        if (key === propertyName) {
            return resolveValue(ctx, prop.value as Expression, mod, state);
        }
    }

    fail(state, `connectionId object has no '${propertyName}' property`, loc);
}

async function resolveExportedValue(
    ctx: PluginContext,
    importer: string,
    source: string,
    exportName: string,
    state: ResolutionState,
): Promise<string> {
    const resolved = await resolveExportedExpression(ctx, importer, source, exportName, state);
    return resolveValue(ctx, resolved.expression, resolved.module, state);
}

async function resolveExportedExpression(
    ctx: PluginContext,
    importer: string,
    source: string,
    exportName: string,
    state: ResolutionState,
): Promise<{ module: ParsedModule; expression: Expression }> {
    const nextState = nextResolutionState(state, `${importer}::${source}::${exportName}`);
    const resolvedId = await resolveModuleId(ctx, importer, source, { required: true });
    if (!resolvedId) {
        fail(nextState, `could not resolve module '${source}' imported from ${importer}`);
    }
    const target = await loadParsedModule(ctx, resolvedId);

    for (const node of target.ast.body) {
        if (node.type === 'ExportNamedDeclaration') {
            if (node.source && typeof node.source.value === 'string') {
                for (const spec of node.specifiers) {
                    if (spec.exported.type === 'Identifier' && spec.exported.name === exportName) {
                        const reName =
                            spec.local.type === 'Identifier'
                                ? spec.local.name
                                : String(spec.local.value);
                        return resolveExportedExpression(
                            ctx,
                            target.id,
                            node.source.value,
                            reName,
                            nextState,
                        );
                    }
                }
                continue;
            }

            for (const spec of node.specifiers) {
                if (spec.exported.type === 'Identifier' && spec.exported.name === exportName) {
                    const localName =
                        spec.local.type === 'Identifier'
                            ? spec.local.name
                            : String(spec.local.value);
                    return {
                        module: target,
                        expression: { type: 'Identifier', name: localName } as Expression,
                    };
                }
            }

            if (node.declaration?.type === 'VariableDeclaration') {
                if (node.declaration.kind !== 'const') {
                    fail(
                        nextState,
                        `'connectionId' must resolve to a 'const' binding; '${exportName}' in '${target.id}' is declared with '${node.declaration.kind}'`,
                    );
                }
                for (const d of node.declaration.declarations) {
                    if (d.id.type === 'Identifier' && d.id.name === exportName && d.init) {
                        return { module: target, expression: d.init };
                    }
                }
            }
        } else if (node.type === 'ExportAllDeclaration') {
            if (node.exported || typeof node.source.value !== 'string') {
                continue;
            }
            try {
                return await resolveExportedExpression(
                    ctx,
                    target.id,
                    node.source.value,
                    exportName,
                    nextState,
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

function nextResolutionState(state: ResolutionState, key: string): ResolutionState {
    if (state.hops + 1 > MAX_HOPS) {
        fail(state, `import tracing depth exceeded (${MAX_HOPS} hops)`);
    }
    if (state.visited.has(key)) {
        fail(state, `cyclic re-export or import chain detected at ${key}`);
    }
    const visited = new Set(state.visited);
    visited.add(key);
    return { ...state, visited, hops: state.hops + 1 };
}

function fail(state: ResolutionState, reason: string, loc?: Node['loc']): never {
    const where = loc?.start
        ? `${state.originFile}:${loc.start.line}:${loc.start.column + 1}`
        : state.originFile;
    throw new ExtractionError(`[connectionId manifest] ${reason} (${state.label} at ${where})`);
}

function failBase(reason: string, loc: Node['loc'], filePath: string): never {
    const where = loc?.start ? `${filePath}:${loc.start.line}:${loc.start.column + 1}` : filePath;
    throw new ExtractionError(`[connectionId manifest] ${reason} (${where})`);
}
