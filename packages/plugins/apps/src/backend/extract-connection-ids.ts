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

/** Hard safety cap — genuine cycles are caught by `visited`, this guards runaway chains. */
const MAX_HOPS = 16;

/**
 * Statically extract every `connectionId` value used inside each exported
 * backend function. Values may be:
 *   - inline string literal (`'abc'`)
 *   - plain template literal with no interpolation (\`abc\`)
 *   - identifier that resolves to a same-file `const` of those forms
 *   - identifier that resolves via an import chain to a `const` of those forms
 *
 * Any other form (dynamic template, call, concatenation, env var, …) throws
 * with the source location so Vite surfaces a framed build error.
 *
 * Returns a map keyed by export name → sorted, deduplicated connection IDs.
 */
export async function extractConnectionIds(
    ctx: PluginContext,
    ast: AstNode,
    filePath: string,
    exportedNames: string[],
): Promise<Map<string, string[]>> {
    if (!isProgram(ast)) {
        throw new Error(
            `Expected a Program node from this.parse() for ${filePath}, got ${ast.type}`,
        );
    }

    const symbols = buildSymbolTable(ast);
    const bodyByExport = findExportedFunctionBodies(ast, exportedNames);
    const result = new Map<string, string[]>();

    for (const name of exportedNames) {
        const body = bodyByExport.get(name);
        if (!body) {
            // Export was declared but we couldn't locate its function body.
            // This is a shape discovery already rejects — defensive empty entry.
            result.set(name, []);
            continue;
        }

        const callSites = findConnectionIdValues(body);
        const ids = new Set<string>();
        for (const { valueNode, keyLoc } of callSites) {
            const id = await resolveValue(ctx, valueNode, symbols, filePath, {
                visited: new Set(),
                hops: 0,
                exportName: name,
                originFile: filePath,
                keyLoc,
            });
            ids.add(id);
        }
        result.set(name, [...ids].sort());
    }

    return result;
}

// ---------- AST helpers ----------

function isProgram(node: AstNode): node is AstNode & Program {
    return node.type === 'Program';
}

type LocalSymbols = {
    /** Top-level `const X = <init>` bindings (and `let`/`var`). */
    localConsts: Map<string, Expression>;
    /** Import specifiers: local name → `{ source, imported }`. `imported` is the remote name. */
    importBindings: Map<string, { source: string; imported: string }>;
};

/**
 * Build a table of top-level symbols from a module's AST so later passes can
 * resolve identifiers to their originating declaration.
 *
 * Two kinds of bindings are tracked:
 * - `localConsts`: same-file `const`/`let`/`var` and `export const` declarations,
 *   mapped to their initializer expression (used to resolve local string constants).
 * - `importBindings`: named imports, mapped to `{ source, imported }` so callers
 *   can follow the binding to another module. Default and namespace imports are
 *   intentionally skipped since they can't resolve to a statically-known value.
 */
function buildSymbolTable(ast: Program): LocalSymbols {
    const localConsts = new Map<string, Expression>();
    const importBindings = new Map<string, { source: string; imported: string }>();

    for (const node of ast.body) {
        if (node.type === 'VariableDeclaration') {
            // e.g. `const MY_ID = 'abc-123';`
            // or multi-declarator: `const A = 'x', B = 'y';` — one VariableDeclaration, two declarators.
            for (const d of node.declarations) {
                if (d.id.type === 'Identifier' && d.init) {
                    localConsts.set(d.id.name, d.init);
                }
            }
        } else if (node.type === 'ImportDeclaration' && typeof node.source.value === 'string') {
            // e.g. `import { MY_ID } from './constants';`
            const source = node.source.value;
            for (const spec of node.specifiers) {
                if (spec.type === 'ImportSpecifier') {
                    const imported =
                        spec.imported.type === 'Identifier'
                            ? spec.imported.name
                            : String(spec.imported.value);
                    importBindings.set(spec.local.name, { source, imported });
                }
                // ImportDefaultSpecifier / ImportNamespaceSpecifier intentionally skipped:
                // they can't resolve to a statically-known string constant we'd accept.
            }
        } else if (node.type === 'ExportNamedDeclaration' && node.declaration) {
            // e.g. `export const MY_ID = 'abc-123';`
            // `export const X = <init>` — also track so same-file exported consts resolve.
            if (node.declaration.type === 'VariableDeclaration') {
                for (const d of node.declaration.declarations) {
                    if (d.id.type === 'Identifier' && d.init) {
                        localConsts.set(d.id.name, d.init);
                    }
                }
            }
        }
    }

    return { localConsts, importBindings };
}

/** Map export name → function body node. Supports `export function f(){}` and `export const f = () => {}`. */
function findExportedFunctionBodies(ast: Program, names: string[]): Map<string, Node> {
    const wanted = new Set(names);
    const out = new Map<string, Node>();

    for (const node of ast.body) {
        if (node.type !== 'ExportNamedDeclaration' || !node.declaration) {
            continue;
        }
        const decl = node.declaration;
        if (decl.type === 'FunctionDeclaration' && decl.id && wanted.has(decl.id.name)) {
            out.set(decl.id.name, decl.body);
        } else if (decl.type === 'VariableDeclaration') {
            for (const d of decl.declarations) {
                if (d.id.type !== 'Identifier' || !wanted.has(d.id.name) || !d.init) {
                    continue;
                }
                if (
                    d.init.type === 'ArrowFunctionExpression' ||
                    d.init.type === 'FunctionExpression'
                ) {
                    out.set(d.id.name, d.init.body);
                }
            }
        }
    }
    return out;
}

type ConnectionIdCallSite = {
    valueNode: Expression;
    keyLoc: Node['loc'];
};

/**
 * Walk a function body for every CallExpression whose first argument is an
 * ObjectExpression containing a `connectionId` property — record the value node.
 * Nested functions are walked too (we don't restrict to the top scope).
 */
function findConnectionIdValues(root: Node): ConnectionIdCallSite[] {
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

        if (node.type === 'CallExpression') {
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
 * Resolve an identifier `name` to its static string value by following its
 * binding in the current file's symbol table.
 *
 * Three outcomes:
 * - Bound to a same-file `const`/`let`/`var` (or `export const`): recurse into
 *   {@link resolveValue} on that initializer, staying in this file.
 * - Bound to a named import: hand off to {@link resolveCrossFile} to load and
 *   trace the source module.
 * - Not bound anywhere: fail with the identifier's source location.
 */
async function resolveIdentifier(
    ctx: PluginContext,
    name: string,
    symbols: LocalSymbols,
    currentFile: string,
    state: ResolutionState,
    loc: Node['loc'],
): Promise<string> {
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

            // `export const X = <init>` / `export function X(){}`
            if (node.declaration?.type === 'VariableDeclaration') {
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
