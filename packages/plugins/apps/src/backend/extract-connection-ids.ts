// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    Expression,
    Node,
    ObjectExpression,
    Program,
    Property,
    TemplateLiteral,
} from 'estree';
import type { AstNode, PluginContext } from 'rollup';

import { enumerateBackendExports } from './discovery';
import type { ExportedBinding } from './discovery';

/** Hard safety cap — genuine cycles are caught by `visited`, this guards runaway chains. */
const MAX_HOPS = 16;

/**
 * Callees we scan for a static `connectionId` argument. We only care about
 * calls into the action catalog (e.g. `@datadog/action-catalog/http/http`)
 * because that's the only API whose server-side allowlist our manifest feeds.
 * A prefix match covers every submodule path.
 */
const ACTION_CATALOG_PACKAGE = '@datadog/action-catalog';

/**
 * Statically extract every `connectionId` value passed to an action-catalog
 * call site inside each exported backend function. Values may be:
 *   - inline string literal (`'abc'`)
 *   - plain template literal with no interpolation (\`abc\`)
 *   - identifier that resolves to a same-file `const` of those forms
 *   - identifier that resolves via an import chain to a `const` of those forms
 *
 * Any other form (dynamic template, call, concatenation, env var, mutable
 * binding, …) throws with the source location so Vite surfaces a framed
 * build error.
 *
 * Exports whose body lives in another module (`import { x } from './y'; export { x }`)
 * are emitted with an empty allowlist and a debug log; the server allowlist
 * will still reject any mismatched calls at runtime.
 *
 * Returns a map keyed by export name → sorted, deduplicated connection IDs.
 */
export async function extractConnectionIds(
    ctx: PluginContext,
    ast: AstNode,
    filePath: string,
): Promise<Map<string, string[]>> {
    const bindings = enumerateBackendExports(ast, filePath);

    if (!isProgram(ast)) {
        // enumerateBackendExports already validated this, but narrow the type for the rest.
        throw new Error(`Expected a Program node from this.parse() for ${filePath}`);
    }

    const symbols = buildSymbolTable(ast);
    const result = new Map<string, string[]>();

    for (const binding of bindings) {
        if (binding.kind === 'imported') {
            result.set(binding.name, []);
            logImportedSkip(ctx, filePath, binding);
            continue;
        }

        const callSites = findConnectionIdValues(binding.body, symbols);
        const ids = new Set<string>();
        for (const { valueNode, keyLoc } of callSites) {
            const id = await resolveValue(ctx, valueNode, symbols, filePath, {
                visited: new Set(),
                hops: 0,
                exportName: binding.name,
                originFile: filePath,
                keyLoc,
            });
            ids.add(id);
        }
        result.set(binding.name, [...ids].sort());
    }

    return result;
}

function logImportedSkip(ctx: PluginContext, filePath: string, binding: ExportedBinding): void {
    if (binding.kind !== 'imported') {
        return;
    }
    const where =
        binding.source === '<opaque>' || binding.source === '<local-alias>'
            ? `(${binding.source})`
            : `from '${binding.source}'`;
    const msg =
        `[connectionId manifest] Export '${binding.name}' in ${filePath} is re-exported ${where} — ` +
        `connection IDs cannot be statically traced across files. Manifest will allowlist no ` +
        `connections for this export; the server will reject any mismatched calls at runtime.`;
    if (typeof ctx.debug === 'function') {
        ctx.debug(msg);
    }
}

// ---------- AST helpers ----------

function isProgram(node: AstNode): node is AstNode & Program {
    return node.type === 'Program';
}

type MutableKind = 'let' | 'var';

type LocalSymbols = {
    /** Top-level `const X = <init>` bindings. Mutable (`let`/`var`) bindings are tracked
     *  separately so resolution can reject them. */
    localConsts: Map<string, Expression>;
    /** Top-level `let`/`var` bindings — carried so we can fail with a targeted error. */
    localMutables: Map<string, { kind: MutableKind; loc: Node['loc'] }>;
    /** Named imports: local name → `{ source, imported }`. */
    importBindings: Map<string, { source: string; imported: string }>;
    /** Namespace imports: local name → source module, e.g. `import * as http from '…'`. */
    namespaceImports: Map<string, string>;
};

function isMutableKind(kind: string): kind is MutableKind {
    return kind === 'let' || kind === 'var';
}

/**
 * Build a table of top-level symbols so later passes can resolve identifiers
 * to their originating declaration and gate call-site scanning by callee origin.
 */
function buildSymbolTable(ast: Program): LocalSymbols {
    const localConsts = new Map<string, Expression>();
    const localMutables = new Map<string, { kind: MutableKind; loc: Node['loc'] }>();
    const importBindings = new Map<string, { source: string; imported: string }>();
    const namespaceImports = new Map<string, string>();

    const recordVariableDeclaration = (decl: {
        kind: string;
        declarations: { id: { type: string; name?: string; loc?: Node['loc'] }; init?: unknown }[];
    }): void => {
        // e.g. `const MY_ID = 'abc-123';` / `let X = …;` / `using y = …;` (unsupported — skipped)
        for (const d of decl.declarations) {
            if (d.id.type !== 'Identifier' || !d.id.name) {
                continue;
            }
            if (decl.kind === 'const' && d.init) {
                localConsts.set(d.id.name, d.init as Expression);
            } else if (isMutableKind(decl.kind)) {
                localMutables.set(d.id.name, { kind: decl.kind, loc: d.id.loc ?? null });
            }
            // `using` / `await using` — ignored; they can't hold a static string we'd accept.
        }
    };

    for (const node of ast.body) {
        if (node.type === 'VariableDeclaration') {
            recordVariableDeclaration(node);
        } else if (node.type === 'ImportDeclaration' && typeof node.source.value === 'string') {
            const source = node.source.value;
            for (const spec of node.specifiers) {
                if (spec.type === 'ImportSpecifier') {
                    // e.g. `import { MY_ID } from './constants';`
                    const imported =
                        spec.imported.type === 'Identifier'
                            ? spec.imported.name
                            : String(spec.imported.value);
                    importBindings.set(spec.local.name, { source, imported });
                } else if (spec.type === 'ImportNamespaceSpecifier') {
                    // e.g. `import * as http from '@datadog/action-catalog/http/http';`
                    namespaceImports.set(spec.local.name, source);
                }
                // ImportDefaultSpecifier intentionally skipped — no statically-known value.
            }
        } else if (node.type === 'ExportNamedDeclaration' && node.declaration) {
            // e.g. `export const MY_ID = 'abc-123';` / `export let …`
            if (node.declaration.type === 'VariableDeclaration') {
                recordVariableDeclaration(node.declaration);
            }
        }
    }

    return { localConsts, localMutables, importBindings, namespaceImports };
}

type ConnectionIdCallSite = {
    valueNode: Expression;
    keyLoc: Node['loc'];
};

/**
 * Walk a function body collecting every action-catalog call site whose first
 * argument object contains a `connectionId` property, recording the value node.
 *
 * Callees are considered "action catalog" when:
 *   - a direct identifier is bound to a named import from `@datadog/action-catalog`, or
 *   - a member expression's object is a namespace import from `@datadog/action-catalog`.
 *
 * Unrelated calls (e.g. `logger.info({ connectionId })`) are ignored so users
 * can legitimately use the `connectionId` key in their own code.
 */
function findConnectionIdValues(root: Node, symbols: LocalSymbols): ConnectionIdCallSite[] {
    const out: ConnectionIdCallSite[] = [];

    const visit = (node: Node | null | undefined): void => {
        if (!node || typeof node !== 'object') {
            return;
        }
        if (Array.isArray(node)) {
            for (const c of node as unknown as Node[]) {
                visit(c);
            }
            return;
        }
        if (!('type' in node)) {
            return;
        }

        if (node.type === 'CallExpression' && isActionCatalogCallee(node.callee, symbols)) {
            const firstArg = node.arguments[0];
            if (firstArg && firstArg.type === 'ObjectExpression') {
                const prop = findConnectionIdProp(firstArg);
                if (prop) {
                    out.push({
                        valueNode: prop.value as Expression,
                        keyLoc: prop.loc ?? null,
                    });
                }
            }
        }

        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'range' || key === 'parent') {
                continue;
            }
            visit((node as unknown as Record<string, Node>)[key]);
        }
    };

    visit(root);
    return out;
}

function isActionCatalogCallee(callee: Node, symbols: LocalSymbols): boolean {
    // e.g. `request({ … })` where `request` is imported from `@datadog/action-catalog/*`
    if (callee.type === 'Identifier') {
        const imp = symbols.importBindings.get(callee.name);
        return imp !== undefined && imp.source.startsWith(ACTION_CATALOG_PACKAGE);
    }
    // e.g. `http.request({ … })` where `http` is `import * as http from '@datadog/action-catalog/…'`
    if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier') {
        const ns = symbols.namespaceImports.get(callee.object.name);
        return ns !== undefined && ns.startsWith(ACTION_CATALOG_PACKAGE);
    }
    return false;
}

function findConnectionIdProp(obj: ObjectExpression): Property | undefined {
    for (const p of obj.properties) {
        if (p.type !== 'Property') {
            continue;
        }
        if (p.computed) {
            continue;
        }
        const key = p.key;
        if (key.type === 'Identifier' && key.name === 'connectionId') {
            return p;
        }
        if (key.type === 'Literal' && key.value === 'connectionId') {
            return p;
        }
    }
    return undefined;
}

// ---------- Resolution ----------

type ResolutionState = {
    visited: Set<string>;
    hops: number;
    exportName: string;
    originFile: string;
    keyLoc: Node['loc'];
};

class ExtractionError extends Error {}

function fail(state: ResolutionState, reason: string, loc?: Node['loc']): never {
    const where = loc?.start
        ? `${state.originFile}:${loc.start.line}:${loc.start.column + 1}`
        : state.originFile;
    throw new ExtractionError(
        `[connectionId manifest] ${reason} (export '${state.exportName}' at ${where})`,
    );
}

/**
 * Resolve an arbitrary expression node to its static string value, recursing
 * through identifier bindings until we land on a literal.
 *
 * `node` may be the original `connectionId` property value, but during
 * recursion it's whatever we've followed to — a `const` initializer, a
 * re-exported binding's target, etc.
 *
 * Accepts: string `Literal`, interpolation-free `TemplateLiteral`, and
 * `Identifier` that resolves (locally or via imports) to one of those forms.
 * Anything else calls {@link fail} with a source location.
 */
async function resolveValue(
    ctx: PluginContext,
    node: Expression,
    symbols: LocalSymbols,
    currentFile: string,
    state: ResolutionState,
): Promise<string> {
    if (node.type === 'Literal' && typeof node.value === 'string') {
        // e.g. the `'abc-123'` in `connectionId: 'abc-123'` or `const MY_ID = 'abc-123'`
        return node.value;
    }
    if (node.type === 'TemplateLiteral') {
        // e.g. a plain `abc-123` template, as in connectionId: `abc-123` or const MY_ID = `abc-123`
        return requireStaticTemplate(node, state);
    }
    if (node.type === 'Identifier') {
        // e.g. the `MY_ID` in `connectionId: MY_ID` or `const ALIAS = MY_ID`
        return resolveIdentifier(ctx, node.name, symbols, currentFile, state, node.loc);
    }
    fail(
        state,
        `'connectionId' must be a string literal, a plain template literal, or an identifier that resolves to one; got ${node.type}`,
        node.loc,
    );
}

/**
 * Return the cooked text of a template literal, but only if it has no
 * interpolations.
 *
 * Accepts: `` `abc-123` `` → `'abc-123'`.
 * Rejects: `` `abc-${suffix}` ``, `` `${prefix}-123` ``, etc. — these fail
 * because we can't statically know the resulting string.
 */
function requireStaticTemplate(node: TemplateLiteral, state: ResolutionState): string {
    if (node.expressions.length > 0) {
        fail(state, `'connectionId' template literals must not contain interpolations`, node.loc);
    }
    const q = node.quasis[0];
    return q.value.cooked ?? q.value.raw;
}

/**
 * Resolve an identifier by following its binding. `const` bindings recurse;
 * `let`/`var` bindings fail because their runtime value can drift from the
 * initializer we'd read; imports hand off to {@link resolveCrossFile};
 * unresolved names fail.
 */
async function resolveIdentifier(
    ctx: PluginContext,
    name: string,
    symbols: LocalSymbols,
    currentFile: string,
    state: ResolutionState,
    loc: Node['loc'],
): Promise<string> {
    const mutable = symbols.localMutables.get(name);
    if (mutable) {
        fail(
            state,
            `'connectionId' must resolve to a 'const' binding; '${name}' is declared with '${mutable.kind}' and can be reassigned`,
            loc,
        );
    }
    const localInit = symbols.localConsts.get(name);
    if (localInit) {
        return resolveValue(ctx, localInit, symbols, currentFile, state);
    }
    const binding = symbols.importBindings.get(name);
    if (binding) {
        return resolveCrossFile(ctx, currentFile, binding.source, binding.imported, state);
    }
    fail(state, `identifier '${name}' is not defined in ${currentFile} and is not imported`, loc);
}

/**
 * Follow a named import across module boundaries: resolve `source` relative to
 * `importer`, load and parse the target module, then find the binding exported
 * as `importedName` and continue resolution from there.
 *
 * Handles these export forms in the target module:
 * - `export { X } from './foo'` (and `export { Y as X } from './foo'`) — recurses into
 *   the onward module.
 * - `export { X }` / `export { X as Y }` — recurses into the target's own
 *   symbol table via {@link resolveIdentifier}.
 * - `export const X = <init>` — recurses into {@link resolveValue} on the initializer.
 * - `export * from './bar'` — tries each barrel in order, swallowing only
 *   "not found" errors so the search continues.
 *
 * Fails on: unresolved or external modules, modules that produce no code,
 * cyclic re-export chains (caught via `state.visited`), and chains deeper
 * than `MAX_HOPS`.
 */
async function resolveCrossFile(
    ctx: PluginContext,
    importer: string,
    source: string,
    importedName: string,
    state: ResolutionState,
): Promise<string> {
    const nextHops = state.hops + 1;
    if (nextHops > MAX_HOPS) {
        fail(
            state,
            `import tracing depth exceeded (${MAX_HOPS} hops) while resolving '${importedName}'`,
        );
    }

    const resolved = await ctx.resolve(source, importer, { skipSelf: false });
    if (!resolved || resolved.external) {
        fail(
            state,
            `could not resolve module '${source}' (imported from ${importer}) while following 'connectionId' — external modules are not supported`,
        );
    }
    const targetId = resolved.id;

    const key = `${targetId}::${importedName}`;
    if (state.visited.has(key)) {
        fail(state, `cyclic re-export chain detected at ${targetId}::${importedName}`);
    }
    state.visited.add(key);

    const info = await ctx.load({ id: targetId });
    const code = info.code;
    if (code === null || code === undefined) {
        fail(state, `module '${targetId}' produced no code when loaded for connectionId tracing`);
    }
    const targetAst = ctx.parse(code) as unknown as Program;
    const targetSymbols = buildSymbolTable(targetAst);
    const nextState: ResolutionState = { ...state, hops: nextHops };

    // Look for the exported binding in the target file.
    for (const node of targetAst.body) {
        if (node.type === 'ExportNamedDeclaration') {
            // Re-export: `export { X } from './foo'` / `export { Y as X } from './foo'`
            if (node.source && typeof node.source.value === 'string') {
                for (const spec of node.specifiers) {
                    if (
                        spec.exported.type === 'Identifier' &&
                        spec.exported.name === importedName
                    ) {
                        const reSource = node.source.value;
                        const reName =
                            spec.local.type === 'Identifier'
                                ? spec.local.name
                                : String((spec.local as { value: string }).value);
                        return resolveCrossFile(ctx, targetId, reSource, reName, nextState);
                    }
                }
                continue;
            }

            // Local re-export: `const X = …; export { X }` / `export { X as Y }`
            for (const spec of node.specifiers) {
                if (spec.exported.type === 'Identifier' && spec.exported.name === importedName) {
                    const localName =
                        spec.local.type === 'Identifier'
                            ? spec.local.name
                            : String((spec.local as { value: string }).value);
                    return resolveIdentifier(
                        ctx,
                        localName,
                        targetSymbols,
                        targetId,
                        nextState,
                        spec.loc,
                    );
                }
            }

            // `export const X = <init>`
            if (node.declaration?.type === 'VariableDeclaration') {
                if (node.declaration.kind !== 'const') {
                    fail(
                        state,
                        `'connectionId' must resolve to a 'const' binding; '${importedName}' in '${targetId}' is declared with '${node.declaration.kind}'`,
                    );
                }
                for (const d of node.declaration.declarations) {
                    if (d.id.type === 'Identifier' && d.id.name === importedName && d.init) {
                        return resolveValue(ctx, d.init, targetSymbols, targetId, nextState);
                    }
                }
            }
        } else if (node.type === 'ExportAllDeclaration') {
            // `export * from './bar'` (no namespace) / `export * as NS from './bar'`.
            // Only the plain `export *` form can re-export our name.
            if (node.exported) {
                continue;
            }
            if (typeof node.source.value !== 'string') {
                continue;
            }
            try {
                return await resolveCrossFile(
                    ctx,
                    targetId,
                    node.source.value,
                    importedName,
                    nextState,
                );
            } catch (e) {
                if (e instanceof ExtractionError && /not found/.test(e.message)) {
                    // Try the next `export *` — normal.
                    continue;
                }
                throw e;
            }
        }
    }

    fail(state, `export '${importedName}' not found in '${targetId}' while resolving connectionId`);
}
