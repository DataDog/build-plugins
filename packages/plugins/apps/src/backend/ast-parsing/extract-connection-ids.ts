// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type * as eslintScope from 'eslint-scope';
import type {
    BaseNode,
    ExportNamedDeclaration,
    ExportSpecifier,
    Identifier,
    ImportDeclaration,
    ImportSpecifier,
    Literal,
} from 'estree';

import {
    analyzeActionCatalogScopes,
    findActionCatalogCallSites,
    isImportVariable,
    type ScopeAnalysis,
} from './action-catalog-call-sites';
import { collectActionCatalogImports } from './action-catalog-imports';
import {
    collectSameModuleConnectionIdBindings,
    type ConnectionIdResolutionContextInput,
    extractConnectionIdFromActionCall,
    type ImportedConnectionIdResolver,
    type ImportedConnectionIdValue,
} from './connection-id-values';
import type { ParsedModuleRecord } from './module-graph';
import { ensureProgram } from './type-guards';

/**
 * Optional extension points for extracting connection IDs from one module.
 *
 * Example:
 *
 * ```ts
 * extractConnectionIds(record.ast, record.id, {
 *     getImportResolver: graphImportResolver.getImportResolver(record),
 * });
 * ```
 *
 * lets module-graph extraction add imported value tracing while entry-file
 * extraction keeps using same-module-only resolution by default.
 */
export interface ExtractConnectionIdsOptions {
    /**
     * Creates an import resolver after this module's same-module context has
     * been collected.
     *
     * Example: the module graph path registers the current module record and
     * returns a resolver that can follow `import { HTTP_ID } from './ids.js'`.
     */
    getImportResolver?: (
        context: ConnectionIdResolutionContextInput,
    ) => ImportedConnectionIdResolver | undefined;
}

/**
 * Extracts sorted, deduped action-catalog connection IDs from one parsed
 * module.
 *
 * Example:
 *
 * ```ts
 * request({ connectionId: HTTP_ID, inputs: {} });
 * ```
 *
 * finds action-catalog call sites, collects same-module binding facts, and
 * resolves each `connectionId` value. Graph extraction can pass an import
 * resolver through `options` to support imported constants and object roots.
 */
export function extractConnectionIds(
    ast: BaseNode,
    filePath: string,
    options: ExtractConnectionIdsOptions = {},
): string[] {
    const program = ensureProgram(ast, filePath);

    const imports = collectActionCatalogImports(program);
    const scopeAnalysis = analyzeActionCatalogScopes(program, imports);
    const bindings = collectSameModuleConnectionIdBindings(program, scopeAnalysis);
    // Example: graph extraction registers the current module before resolving
    // imported values; same-file extraction leaves this undefined.
    const importResolver = options.getImportResolver?.({
        bindings,
        filePath,
        scopeAnalysis,
    });
    const connectionIds = new Set<string>();

    for (const callSite of findActionCatalogCallSites(program, scopeAnalysis, filePath)) {
        // Example: each known `request({ connectionId: ... })` call contributes
        // zero or one resolved static connection ID.
        const connectionId = extractConnectionIdFromActionCall(
            callSite,
            bindings,
            scopeAnalysis,
            filePath,
            importResolver,
        );
        if (connectionId) {
            // Example: repeated calls with the same `HTTP_ID` collapse to one
            // allowlist entry for the backend file.
            connectionIds.add(connectionId);
        }
    }

    return [...connectionIds].sort();
}

/**
 * Per-module connection ID import/export analysis used while resolving imported
 * `connectionId` values.
 *
 * Example:
 *
 * ```ts
 * import { HTTP_ID } from './ids.js';
 * export { SLACK_ID as ACTIVE_SLACK_ID } from './slack.js';
 * export * from './shared.js';
 * ```
 *
 * records the local `HTTP_ID` import binding, an `ACTIVE_SLACK_ID` re-export,
 * and one star-export edge to `./shared.js`.
 */
interface ModuleConnectionIdAnalysis extends ConnectionIdResolutionContextInput {
    /**
     * Imported variables keyed by eslint-scope binding identity.
     *
     * Example:
     *
     * ```ts
     * import { HTTP_ID as ACTIVE_ID } from './ids.js';
     * ```
     *
     * maps the local `ACTIVE_ID` variable to imported name `HTTP_ID` and the
     * resolved `./ids.js` module ID.
     */
    importsByVariable: Map<eslintScope.Variable, ModuleImportBinding>;
    /**
     * Named exports backed by variables declared in the current module.
     *
     * Example:
     *
     * ```ts
     * const HTTP_ID = 'conn-http';
     * export { HTTP_ID as ACTIVE_ID };
     * ```
     *
     * maps exported name `ACTIVE_ID` to the local `HTTP_ID` variable.
     */
    localExports: Map<string, eslintScope.Variable>;
    /**
     * Named exports forwarded from another module.
     *
     * Example:
     *
     * ```ts
     * export { HTTP_ID as ACTIVE_ID } from './ids.js';
     * ```
     *
     * maps exported name `ACTIVE_ID` to imported name `HTTP_ID` in the resolved
     * `./ids.js` module.
     */
    reExports: Map<string, ModuleReExport>;
    /**
     * Star export edges used only when they resolve one unambiguous export.
     *
     * Example:
     *
     * ```ts
     * export * from './ids.js';
     * ```
     *
     * records a star-export edge to the resolved `./ids.js` module.
     */
    starExports: ModuleStarExport[];
}

/**
 * Import binding visible in a module.
 *
 * Example:
 *
 * ```ts
 * import { HTTP_ID as ACTIVE_ID } from './ids.js';
 * import DEFAULT_ID from './ids.js';
 * import * as ids from './ids.js';
 * ```
 *
 * records named imports with their imported export name, while default and
 * namespace imports are recorded so they can fail closed with clear errors.
 */
type ModuleImportBinding =
    /**
     * Named import that can be followed to a concrete exported binding.
     *
     * Example:
     *
     * ```ts
     * import { HTTP_ID as ACTIVE_ID } from './ids.js';
     * ```
     *
     * records `importedName: 'HTTP_ID'` for the local `ACTIVE_ID` variable.
     */
    | {
          /**
           * Export name requested from the source module.
           *
           * Example: `HTTP_ID` in `import { HTTP_ID as ACTIVE_ID }`.
           */
          importedName: string;
          /**
           * Marks this as a supported named import.
           *
           * Example: `import { HTTP_ID } from './ids.js'`.
           */
          kind: 'named';
          /**
           * Canonical module ID for the import source.
           *
           * Example: `/project/src/backend/ids.js` for source `./ids.js`.
           */
          resolvedId: string;
      }
    /**
     * Import forms that are recorded only so value resolution can reject them
     * with clear fail-closed errors.
     *
     * Example:
     *
     * ```ts
     * import HTTP_ID from './ids.js';
     * import * as ids from './ids.js';
     * ```
     */
    | {
          /**
           * Unsupported import shape.
           *
           * Example: `default` for `import HTTP_ID ...`, `namespace` for
           * `import * as ids ...`.
           */
          kind: 'default' | 'namespace';
          /**
           * Canonical module ID for the import source.
           *
           * Example: `/project/src/backend/ids.js` for source `./ids.js`.
           */
          resolvedId: string;
      };

/**
 * A named re-export edge from the current module to another resolved module.
 *
 * Example:
 *
 * ```ts
 * export { HTTP_ID as ACTIVE_ID } from './ids.js';
 * ```
 *
 * records `{ importedName: 'HTTP_ID', resolvedId: '/project/src/backend/ids.js' }`
 * under exported name `ACTIVE_ID`.
 */
interface ModuleReExport {
    /**
     * Name to read from the re-exported module.
     *
     * Example: `HTTP_ID` in `export { HTTP_ID as ACTIVE_ID } from './ids.js'`.
     */
    importedName: string;
    /**
     * Canonical module ID for the re-export source.
     *
     * Example: `/project/src/backend/ids.js` for source `./ids.js`.
     */
    resolvedId: string;
}

/**
 * A star re-export edge from the current module to another resolved module.
 *
 * Example:
 *
 * ```ts
 * export * from './ids.js';
 * ```
 *
 * records `{ resolvedId: '/project/src/backend/ids.js' }`.
 */
interface ModuleStarExport {
    /**
     * Canonical module ID for the star-export source.
     *
     * Example: `/project/src/backend/ids.js` for
     * `export * from './ids.js'`.
     */
    resolvedId: string;
}

/**
 * Shared mutable state for one graph-aware import resolver instance.
 *
 * Example:
 *
 * ```ts
 * const importResolver = createModuleGraphConnectionIdImportResolver(modules);
 * ```
 *
 * creates one state object whose analysis cache and cycle tracking are reused
 * while extracting all reachable modules for one backend entry.
 */
interface ModuleGraphImportResolverState {
    /**
     * Cached per-module import/export analyses keyed by canonical module ID.
     *
     * Example: once `/project/src/backend/ids.js` is analyzed, later imports
     * from the same module reuse the cached metadata.
     */
    analyses: Map<string, ModuleConnectionIdAnalysis>;
    /**
     * Parsed reachable module graph records supplied by backend graph
     * extraction.
     *
     * Example: the map contains records for `actions.backend.ts`, reachable
     * helper modules, and imported local `ids.ts` modules.
     */
    modules: ReadonlyMap<string, ParsedModuleRecord>;
    /**
     * Export keys currently being resolved, used to detect cycles.
     *
     * Example: resolving `/project/a.js\0A` twice before release means an
     * import/export cycle was found.
     */
    resolvingExports: Set<string>;
}

/**
 * Factory returned by `createModuleGraphConnectionIdImportResolver`.
 *
 * Example:
 *
 * ```ts
 * const graphImportResolver = createModuleGraphConnectionIdImportResolver(modules);
 * const getImportResolver = graphImportResolver.getImportResolver(record);
 * ```
 *
 * captures graph-wide state while exposing a per-module registration hook to
 * `extractConnectionIds`.
 */
interface ModuleGraphConnectionIdImportResolverFactory {
    /**
     * Builds the per-module callback expected by `extractConnectionIds`.
     *
     * Example:
     *
     * ```ts
     * extractConnectionIds(record.ast, record.id, {
     *     getImportResolver: graphImportResolver.getImportResolver(record),
     * });
     * ```
     *
     * registers `record` with the current module's resolution context and
     * returns the shared graph-aware resolver.
     */
    getImportResolver: (
        record: ParsedModuleRecord,
    ) => (context: ConnectionIdResolutionContextInput) => ImportedConnectionIdResolver;
}

/**
 * Internal sentinel used while probing export paths. Callers convert it into a
 * user-facing fail-closed connection ID error at the import site.
 */
class MissingExportError extends Error {}

/**
 * Creates the graph-aware import resolver used by reachable-module connection
 * ID extraction.
 *
 * Example:
 *
 * ```ts
 * const importResolver = createModuleGraphConnectionIdImportResolver(modules);
 *
 * extractConnectionIds(record.ast, record.id, {
 *     getImportResolver: importResolver.getImportResolver(record),
 * });
 * ```
 *
 * The returned resolver follows named imports, re-exports, and unambiguous
 * star exports through the already-collected module graph. It fails closed for
 * missing graph records, default or namespace imports, ambiguous star exports,
 * and import/export cycles.
 */
export function createModuleGraphConnectionIdImportResolver(
    modules: ReadonlyMap<string, ParsedModuleRecord>,
): ModuleGraphConnectionIdImportResolverFactory {
    const state: ModuleGraphImportResolverState = {
        analyses: new Map(),
        modules,
        resolvingExports: new Set(),
    };
    const resolver: ImportedConnectionIdResolver = {
        resolveImportedConnectionIdValue(variable, localName, filePath) {
            return resolveImportedConnectionIdValue(variable, localName, filePath, state, resolver);
        },
    };

    return {
        getImportResolver(record) {
            return (context) => registerModuleContext(record, context, state, resolver);
        },
    };
}

/**
 * Registers the same-module resolution context for one module before scanning
 * its action-catalog calls.
 *
 * Example:
 *
 * ```ts
 * import { HTTP_ID } from './ids.js';
 * request({ connectionId: HTTP_ID, inputs: {} });
 * ```
 *
 * stores the current module's imports, exports, scope analysis, and local
 * connection ID bindings so later imported-value reads can resolve `HTTP_ID`.
 */
function registerModuleContext(
    record: ParsedModuleRecord,
    context: ConnectionIdResolutionContextInput,
    state: ModuleGraphImportResolverState,
    resolver: ImportedConnectionIdResolver,
): ImportedConnectionIdResolver {
    state.analyses.set(record.id, collectModuleAnalysis(record, context, resolver));
    return resolver;
}

/**
 * Resolves the exported value behind one imported local binding.
 *
 * Example:
 *
 * ```ts
 * import { HTTP_ID as ACTIVE_ID } from './ids.js';
 * request({ connectionId: ACTIVE_ID, inputs: {} });
 * ```
 *
 * follows the local `ACTIVE_ID` variable to exported name `HTTP_ID` in the
 * resolved `./ids.js` module.
 */
function resolveImportedConnectionIdValue(
    variable: eslintScope.Variable,
    localName: string,
    filePath: string,
    state: ModuleGraphImportResolverState,
    resolver: ImportedConnectionIdResolver,
): ImportedConnectionIdValue {
    const analysis = getAnalysis(filePath, state, resolver);
    const binding = analysis.importsByVariable.get(variable);
    if (!binding) {
        // Example: eslint-scope says `HTTP_ID` is imported, but this module's
        // import declaration was not recorded. That means the analysis is
        // internally inconsistent, so fail closed.
        throw unsupportedConnectionId(filePath, `unresolved imported binding ${localName}`);
    }

    if (binding.kind !== 'named') {
        // Example: `import HTTP_ID from './ids.js'` or
        // `import * as ids from './ids.js'`. The first version only supports
        // named imports because they map directly to one exported binding.
        throw unsupportedConnectionId(filePath, `${binding.kind} import ${localName}`);
    }

    try {
        return resolveExport(binding.resolvedId, binding.importedName, filePath, state, resolver);
    } catch (error) {
        if (error instanceof MissingExportError) {
            // Example: `import { HTTP_ID } from './ids.js'` but `ids.js` only
            // exports `SLACK_ID`. Surface the missing export at the import site.
            throw unsupportedConnectionId(
                filePath,
                `missing export ${binding.importedName} from ${binding.resolvedId}`,
            );
        }
        throw error;
    }
}

/**
 * Resolves a named export from a module to the expression that defines its
 * value.
 *
 * Example:
 *
 * ```ts
 * export const HTTP_ID = 'conn-http';
 * export { SLACK_ID } from './slack.js';
 * export * from './shared.js';
 * ```
 *
 * tries direct local exports first, then named re-exports, then unambiguous
 * star exports.
 */
function resolveExport(
    moduleId: string,
    exportName: string,
    requestingFilePath: string,
    state: ModuleGraphImportResolverState,
    resolver: ImportedConnectionIdResolver,
): ImportedConnectionIdValue {
    if (exportName === 'default') {
        // Example: `import HTTP_ID from './ids.js'`. Default export semantics
        // are intentionally out of scope for this resolver.
        throw unsupportedConnectionId(requestingFilePath, 'default exports');
    }

    const analysis = getAnalysis(moduleId, state, resolver);
    const exportKey = `${moduleId}\0${exportName}`;
    if (state.resolvingExports.has(exportKey)) {
        // Example: `a.js` exports `A = B` from `b.js`, and `b.js` exports
        // `B = A` from `a.js`. Stop before recursive export resolution loops.
        throw unsupportedConnectionId(
            requestingFilePath,
            `cyclic import/export chain for ${exportName}`,
        );
    }

    state.resolvingExports.add(exportKey);
    try {
        const local = analysis.localExports.get(exportName);
        if (local) {
            // Example: `export const HTTP_ID = 'conn-http'` or
            // `const HTTP_ID = 'conn-http'; export { HTTP_ID };`.
            return withExportRelease(
                resolveLocalExport(local, exportName, analysis, state, resolver),
                exportKey,
                state,
            );
        }

        const reExport = analysis.reExports.get(exportName);
        if (reExport) {
            // Example: `export { HTTP_ID as ACTIVE_ID } from './ids.js'`.
            // Follow the named edge to the source module and preserve the
            // current export key until the returned expression is resolved.
            try {
                return withExportRelease(
                    resolveExport(
                        reExport.resolvedId,
                        reExport.importedName,
                        analysis.filePath,
                        state,
                        resolver,
                    ),
                    exportKey,
                    state,
                );
            } catch (error) {
                if (error instanceof MissingExportError) {
                    // Example: the barrel says
                    // `export { HTTP_ID } from './ids.js'`, but `ids.js` does
                    // not provide `HTTP_ID`.
                    throw unsupportedConnectionId(
                        analysis.filePath,
                        `missing export ${reExport.importedName} from ${reExport.resolvedId}`,
                    );
                }
                throw error;
            }
        }

        const starMatches: ImportedConnectionIdValue[] = [];
        for (const starExport of analysis.starExports) {
            try {
                // Example: `export * from './ids.js'`. Missing exports are
                // expected while probing star-export candidates, so only
                // successful matches are collected.
                starMatches.push(
                    resolveExport(
                        starExport.resolvedId,
                        exportName,
                        analysis.filePath,
                        state,
                        resolver,
                    ),
                );
            } catch (error) {
                if (error instanceof MissingExportError) {
                    // Example: one star-export source does not export
                    // `HTTP_ID`; keep looking because another star source may
                    // provide it unambiguously.
                    continue;
                }
                throw error;
            }
        }

        if (starMatches.length === 1) {
            // Example: exactly one `export *` source provides `HTTP_ID`, so the
            // barrel has an unambiguous static value.
            return withExportRelease(starMatches[0], exportKey, state);
        }
        if (starMatches.length > 1) {
            // Example: both `export * from './a.js'` and
            // `export * from './b.js'` provide `HTTP_ID`. Reject instead of
            // guessing which export wins.
            for (const match of starMatches) {
                match.release?.();
            }
            throw unsupportedConnectionId(
                requestingFilePath,
                `ambiguous star export ${exportName}`,
            );
        }

        // Example: neither local exports, named re-exports, nor star exports
        // can provide the requested name.
        throw new MissingExportError(`Missing export ${exportName} from ${moduleId}`);
    } catch (error) {
        // If resolution fails before a value is handed back to the caller, the
        // in-progress export key can be released immediately.
        state.resolvingExports.delete(exportKey);
        throw error;
    }
}

/**
 * Resolves an export that is backed by a local eslint-scope variable.
 *
 * Example:
 *
 * ```ts
 * const HTTP_ID = 'conn-http';
 * export { HTTP_ID };
 * ```
 *
 * returns the initializer expression for supported top-level `const` bindings,
 * or follows an imported export relay such as `import { ID } ...; export { ID }`.
 */
function resolveLocalExport(
    variable: eslintScope.Variable,
    exportName: string,
    analysis: ModuleConnectionIdAnalysis,
    state: ModuleGraphImportResolverState,
    resolver: ImportedConnectionIdResolver,
): ImportedConnectionIdValue {
    if (isImportVariable(variable)) {
        // Example: `import { HTTP_ID } from './ids.js'; export { HTTP_ID };`.
        // This local export is only a relay, so continue through the import.
        const binding = analysis.importsByVariable.get(variable);
        if (!binding) {
            // Example: eslint-scope marks `HTTP_ID` as imported, but the import
            // declaration was not captured in module analysis.
            throw unsupportedConnectionId(
                analysis.filePath,
                `unresolved imported export ${exportName}`,
            );
        }
        if (binding.kind !== 'named') {
            // Example: `import HTTP_ID from './ids.js'; export { HTTP_ID };`.
            // Default and namespace import relays stay unsupported.
            throw unsupportedConnectionId(
                analysis.filePath,
                `${binding.kind} import ${exportName}`,
            );
        }
        return resolveExport(
            binding.resolvedId,
            binding.importedName,
            analysis.filePath,
            state,
            resolver,
        );
    }

    const binding = analysis.bindings.byVariable.get(variable);
    if (!binding) {
        // Example:
        // `function makeId() { const HTTP_ID = 'conn'; } export { HTTP_ID }`.
        // Only top-level static bindings are safe to use as exported constants.
        throw unsupportedConnectionId(
            analysis.filePath,
            `non-top-level exported connectionId binding ${exportName}`,
        );
    }

    switch (binding.kind) {
        case 'mutable':
            // Example: `export let HTTP_ID = 'conn-http'`. The value can change
            // before the action runs, so the manifest cannot trust it.
            throw unsupportedConnectionId(
                analysis.filePath,
                `mutable ${binding.declarationKind} exported connectionId binding ${exportName}`,
            );
        case 'unsupported-pattern':
            // Example: `export const { HTTP_ID } = CONNECTIONS`. Destructuring
            // adds aliasing this static resolver does not follow.
            throw unsupportedConnectionId(
                analysis.filePath,
                `destructured exported connectionId binding ${exportName}`,
            );
        case 'reassigned':
            // Example: `export const HTTP_ID = 'conn'; HTTP_ID = nextId`.
            // Even if invalid at runtime, a parsed reassignment fails closed.
            throw unsupportedConnectionId(
                analysis.filePath,
                `reassigned exported connectionId binding ${exportName}`,
            );
        case 'const':
            if (!binding.init) {
                // Example: parser edge cases around `const HTTP_ID;`. Keep the
                // guard explicit even though normal JavaScript rejects it.
                throw unsupportedConnectionId(
                    analysis.filePath,
                    `uninitialized exported connectionId binding ${exportName}`,
                );
            }
            // Example: `export const HTTP_ID = 'conn-http'`. Return the raw
            // expression so the shared value resolver can handle strings,
            // template literals, const chains, and static objects.
            return {
                context: analysis,
                expression: binding.init,
            };
    }
}

/**
 * Wraps a resolved export value with cleanup for the active export-resolution
 * stack.
 *
 * Example:
 *
 * ```ts
 * export { HTTP_ID } from './ids.js';
 * ```
 *
 * keeps the current `HTTP_ID` export marked as resolving until the caller has
 * finished resolving the returned expression, so nested import cycles remain
 * detectable.
 */
function withExportRelease(
    value: ImportedConnectionIdValue,
    exportKey: string,
    state: ModuleGraphImportResolverState,
): ImportedConnectionIdValue {
    return {
        ...value,
        release: () => {
            try {
                // Example: nested re-export resolution may have its own release
                // callback. Run it before clearing this export key.
                value.release?.();
            } finally {
                state.resolvingExports.delete(exportKey);
            }
        },
    };
}

/**
 * Returns cached import/export analysis for a module, computing it on demand.
 *
 * Example:
 *
 * ```ts
 * import { HTTP_ID } from './ids.js';
 * ```
 *
 * causes `ids.js` to be analyzed only if `HTTP_ID` is actually needed while
 * resolving a reachable action-catalog call.
 */
function getAnalysis(
    moduleId: string,
    state: ModuleGraphImportResolverState,
    resolver: ImportedConnectionIdResolver,
): ModuleConnectionIdAnalysis {
    const cached = state.analyses.get(moduleId);
    if (cached) {
        // Example: two calls import from the same `ids.js`; reuse its collected
        // import/export metadata instead of walking its AST twice.
        return cached;
    }

    const record = state.modules.get(moduleId);
    if (!record) {
        // Example: `import { HTTP_ID } from './ids.js'`, but `ids.js` is not in
        // the reachable parsed module graph collected by the backend build.
        throw unsupportedConnectionId(moduleId, `imported value outside reachable graph`);
    }

    const imports = collectActionCatalogImports(record.ast);
    const scopeAnalysis = analyzeActionCatalogScopes(record.ast, imports);
    const bindings = collectSameModuleConnectionIdBindings(record.ast, scopeAnalysis);
    const context = {
        bindings,
        filePath: record.id,
        importResolver: resolver,
        scopeAnalysis,
    };
    const analysis = collectModuleAnalysis(record, context, resolver);
    state.analyses.set(record.id, analysis);
    return analysis;
}

/**
 * Collects import and export metadata from one parsed module.
 *
 * Example:
 *
 * ```ts
 * import { HTTP_ID } from './ids.js';
 * export { HTTP_ID as ACTIVE_ID };
 * export * from './shared.js';
 * ```
 *
 * records import bindings, local export aliases, named re-exports, and star
 * export edges without resolving any values yet.
 */
function collectModuleAnalysis(
    record: ParsedModuleRecord,
    context: ConnectionIdResolutionContextInput,
    importResolver: ImportedConnectionIdResolver,
): ModuleConnectionIdAnalysis {
    const analysis: ModuleConnectionIdAnalysis = {
        ...context,
        importResolver,
        importsByVariable: new Map(),
        localExports: new Map(),
        reExports: new Map(),
        starExports: [],
    };

    for (const node of record.ast.body) {
        if (node.type === 'ImportDeclaration') {
            // Example: `import { HTTP_ID } from './ids.js'`.
            collectImportDeclaration(node, record, analysis);
            continue;
        }

        if (node.type === 'ExportNamedDeclaration') {
            // Examples: `export const HTTP_ID = 'conn'`,
            // `export { HTTP_ID }`, and
            // `export { HTTP_ID } from './ids.js'`.
            collectExportNamedDeclaration(node, record, analysis);
            continue;
        }

        if (node.type === 'ExportAllDeclaration' && node.source && isStringLiteral(node.source)) {
            const resolvedId = getResolvedSource(record, node.source.value);
            if ('exported' in node && node.exported) {
                // Example: `export * as ids from './ids.js'`. ESTree models
                // this as an export-all with an exported name, so record it as
                // a named re-export of `*`.
                analysis.reExports.set(getModuleName(node.exported), {
                    importedName: '*',
                    resolvedId,
                });
            } else {
                // Example: `export * from './ids.js'`. Keep the edge for later
                // unambiguous star-export probing.
                analysis.starExports.push({ resolvedId });
            }
        }
    }

    return analysis;
}

/**
 * Records import specifiers from one static import declaration.
 *
 * Example:
 *
 * ```ts
 * import { HTTP_ID as ACTIVE_ID } from './ids.js';
 * import DEFAULT_ID from './defaults.js';
 * import * as ids from './ids.js';
 * ```
 *
 * maps the declared local variables to named/default/namespace import metadata.
 */
function collectImportDeclaration(
    node: ImportDeclaration,
    record: ParsedModuleRecord,
    analysis: ModuleConnectionIdAnalysis,
): void {
    if (!isStringLiteral(node.source)) {
        // Example: parser edge cases with a non-literal import source cannot be
        // matched to Rollup's resolved static dependency, so ignore the record.
        return;
    }

    const resolvedId = getResolvedSource(record, node.source.value);
    for (const specifier of node.specifiers) {
        const [variable] = analysis.scopeAnalysis.scopeManager.getDeclaredVariables(specifier);
        if (!variable) {
            // Example: if eslint-scope does not produce a variable for an
            // import specifier, there is no stable binding identity to store.
            continue;
        }

        if (specifier.type === 'ImportSpecifier') {
            // Example: `import { HTTP_ID as ACTIVE_ID } from './ids.js'`.
            // Store the exported name `HTTP_ID` under local variable `ACTIVE_ID`.
            analysis.importsByVariable.set(variable, {
                importedName: getImportSpecifierName(specifier),
                kind: 'named',
                resolvedId,
            });
        } else if (specifier.type === 'ImportDefaultSpecifier') {
            // Example: `import HTTP_ID from './ids.js'`. Record it so a later
            // value read can fail closed with a default-import error.
            analysis.importsByVariable.set(variable, { kind: 'default', resolvedId });
        } else if (specifier.type === 'ImportNamespaceSpecifier') {
            // Example: `import * as ids from './ids.js'`. Record it so
            // namespace value reads fail closed explicitly.
            analysis.importsByVariable.set(variable, { kind: 'namespace', resolvedId });
        }
    }
}

/**
 * Records local named exports and named re-export edges from one export
 * declaration.
 *
 * Example:
 *
 * ```ts
 * export const HTTP_ID = 'conn-http';
 * export { LOCAL_ID as HTTP_ID };
 * export { REMOTE_ID as SLACK_ID } from './ids.js';
 * ```
 *
 * maps local exports to eslint-scope variables and re-exports to resolved
 * module edges.
 */
function collectExportNamedDeclaration(
    node: ExportNamedDeclaration,
    record: ParsedModuleRecord,
    analysis: ModuleConnectionIdAnalysis,
): void {
    if (node.declaration) {
        // Example: `export const HTTP_ID = 'conn-http'`. The declaration itself
        // creates the exported binding.
        collectDeclarationExports(node.declaration, analysis);
        return;
    }

    if (node.source && isStringLiteral(node.source)) {
        // Example: `export { HTTP_ID as ACTIVE_ID } from './ids.js'`. This is a
        // named edge to another module, not a local variable export.
        const resolvedId = getResolvedSource(record, node.source.value);
        for (const specifier of node.specifiers) {
            if (specifier.type !== 'ExportSpecifier') {
                // Example: parser-specific export specifier shapes that are not
                // standard named exports are ignored for this resolver.
                continue;
            }
            analysis.reExports.set(getExportedName(specifier), {
                importedName: getModuleName(specifier.local),
                resolvedId,
            });
        }
        return;
    }

    for (const specifier of node.specifiers) {
        if (specifier.type !== 'ExportSpecifier') {
            // Example: ignore non-standard export specifier forms rather than
            // inventing semantics for connection ID resolution.
            continue;
        }
        const variable = findVariable(analysis.scopeAnalysis, getModuleName(specifier.local));
        if (variable) {
            // Example: `const HTTP_ID = 'conn'; export { HTTP_ID as ACTIVE_ID }`.
            analysis.localExports.set(getExportedName(specifier), variable);
        } else {
            // Example: `export { HTTP_ID }` without a local `HTTP_ID` binding.
            // The value resolver will fail later if an action-catalog call
            // needs it.
        }
    }
}

/**
 * Records variables created by an exported declaration.
 *
 * Example:
 *
 * ```ts
 * export const HTTP_ID = 'conn-http';
 * ```
 *
 * maps exported name `HTTP_ID` to the eslint-scope variable declared by the
 * export statement.
 */
function collectDeclarationExports(
    declaration: ExportNamedDeclaration['declaration'],
    analysis: ModuleConnectionIdAnalysis,
): void {
    if (!declaration) {
        // Example: defensive guard for parser shapes where an export wrapper
        // has no declaration payload.
        return;
    }

    for (const variable of analysis.scopeAnalysis.scopeManager.getDeclaredVariables(declaration)) {
        analysis.localExports.set(variable.name, variable);
    }
}

/**
 * Finds a variable by name in the module's eslint-scope analysis.
 *
 * Example:
 *
 * ```ts
 * const HTTP_ID = 'conn-http';
 * export { HTTP_ID as ACTIVE_ID };
 * ```
 *
 * finds the local `HTTP_ID` variable referenced by the export specifier.
 */
function findVariable(
    scopeAnalysis: ScopeAnalysis,
    name: string,
): eslintScope.Variable | undefined {
    for (const scope of scopeAnalysis.scopeManager.scopes) {
        const variable = scope.variables.find((candidate) => candidate.name === name);
        if (variable) {
            // Example: prefer the first eslint-scope variable named `HTTP_ID`;
            // exported top-level names should be present in the module scope.
            return variable;
        }
    }
    return undefined;
}

/**
 * Maps an AST source literal to Rollup's resolved module ID.
 *
 * Example:
 *
 * ```ts
 * import { HTTP_ID } from './ids.js';
 * ```
 *
 * resolves `./ids.js` to the canonical module ID stored on the parsed module
 * record, falling back to the source string if no resolution is available.
 */
function getResolvedSource(record: ParsedModuleRecord, source: string): string {
    return (
        record.staticDependencies.find((dependency) => dependency.source === source)?.resolvedId ??
        source
    );
}

/**
 * Reads the exported name requested by an import specifier.
 *
 * Example:
 *
 * ```ts
 * import { HTTP_ID as ACTIVE_ID } from './ids.js';
 * ```
 *
 * returns `HTTP_ID`, not the local alias `ACTIVE_ID`.
 */
function getImportSpecifierName(specifier: ImportSpecifier): string {
    return getModuleName(specifier.imported);
}

/**
 * Reads the public exported name from an export specifier.
 *
 * Example:
 *
 * ```ts
 * export { LOCAL_ID as HTTP_ID };
 * ```
 *
 * returns `HTTP_ID`, not the local name `LOCAL_ID`.
 */
function getExportedName(specifier: ExportSpecifier): string {
    return getModuleName(specifier.exported);
}

/**
 * Normalizes ESTree identifier and string-literal module names.
 *
 * Example:
 *
 * ```ts
 * export { HTTP_ID };
 * export { "legacy-id" as HTTP_ID };
 * ```
 *
 * returns the identifier name for `HTTP_ID` and the string value for literal
 * export names.
 */
function getModuleName(node: Identifier | Literal): string {
    if (node.type === 'Identifier') {
        // Example: `{ HTTP_ID }` stores the module name directly on the
        // identifier node.
        return node.name;
    }
    // Example: `{ "legacy-id" as HTTP_ID }` uses a literal for the imported or
    // exported module name.
    return String(node.value);
}

/**
 * Narrows unknown ESTree nodes to string literals.
 *
 * Example:
 *
 * ```ts
 * import { HTTP_ID } from './ids.js';
 * ```
 *
 * returns true for the `./ids.js` source literal and false for non-literal
 * parser edge cases.
 */
function isStringLiteral(node: unknown): node is Literal & { value: string } {
    const maybeNode = node as { type?: unknown; value?: unknown } | undefined;
    return maybeNode?.type === 'Literal' && typeof maybeNode.value === 'string';
}

/**
 * Builds the common fail-closed connection ID error for imported value tracing.
 *
 * Example:
 *
 * ```ts
 * import HTTP_ID from './ids.js';
 * request({ connectionId: HTTP_ID, inputs: {} });
 * ```
 *
 * becomes `Unsupported action-catalog connectionId ... default import HTTP_ID`.
 */
function unsupportedConnectionId(filePath: string, unsupported: string): Error {
    return new Error(`Unsupported action-catalog connectionId in ${filePath}: ${unsupported}.`);
}
