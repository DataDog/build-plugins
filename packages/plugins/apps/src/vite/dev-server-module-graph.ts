// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-await-in-loop */

import { readFile } from '@dd/core/helpers/fs';
import type { Logger } from '@dd/core/types';
import { transform } from 'esbuild';
import { parseAst } from 'rollup/parseAst';
import type { ModuleNode, ViteDevServer } from 'vite';

import {
    createParsedModuleRecord,
    getStaticModuleSources,
    type ParsedModuleRecord,
    shouldTraverseCollectedModule,
    unsupportedModuleGraphDependency,
} from '../backend/ast-parsing/module-graph';
import { runBackendStaticChecks } from '../backend/ast-parsing/run-backend-static-checks';
import { LOCAL_EXECUTION_LOAD_SUFFIX } from '../constants';

import { normalizeViteModuleId } from './backend-module-graph-collector';

/**
 * Builds the same `ReadonlyMap<string, ParsedModuleRecord>` shape
 * `createBackendModuleGraphCollector`'s `moduleParsed` hook produces during a real Rollup
 * build, but for the dev server, where that hook never fires (Vite's plugin container
 * doesn't implement it) — instead walking `server.moduleGraph`, which `ssrLoadModule`
 * already populates with the entry's full transitive static-import graph by the time it
 * resolves.
 *
 * Parses each module's source fresh from disk (via `ModuleNode.file`), stripped of TS/JSX
 * by `esbuild.transform` in isolation, rather than Vite's own transform results — the
 * client transform doesn't run for an SSR-only load, and the SSR transform rewrites
 * imports into `__vite_ssr_import__(...)` calls that `collectActionCatalogImports`'s
 * plain-`ImportDeclaration` parser can't read. `esbuild.transform` alone only strips
 * types/JSX, leaving import specifiers untouched, so this sees the same syntax the
 * production build path already trusts.
 *
 * Call only after `loadModule` has resolved for `bareEntryId + LOCAL_EXECUTION_LOAD_SUFFIX`
 * in the same request — the graph is a live side effect of that call. The suffix is
 * appended internally, since Vite keys the loaded node by its full resolved id, so callers
 * only need to pass the bare id `extractConnectionIdsFromModuleGraph` also uses.
 */
export async function collectModuleGraphFromServer(
    server: ViteDevServer,
    bareEntryId: string,
    buildRoot: string,
    log: Logger,
): Promise<ReadonlyMap<string, ParsedModuleRecord>> {
    const records = new Map<string, ParsedModuleRecord>();
    const visited = new Set<string>();
    const pending: ModuleNode[] = [];

    const entryNode = server.moduleGraph.getModuleById(bareEntryId + LOCAL_EXECUTION_LOAD_SUFFIX);
    if (entryNode) {
        pending.push(entryNode);
    }

    while (pending.length > 0) {
        const node = pending.shift()!;

        // Checked before the visited-set dedup below, not after: a query'd id (e.g.
        // `./helper.ts?raw`) and its plain counterpart (`./helper.ts`) normalize to the same
        // moduleId, so if the plain form was visited first, deduping on moduleId would silently
        // skip this check for the query'd form instead of rejecting it. A remaining query beyond
        // the local-execution marker means Vite treats this id as a non-source resource whose
        // runtime value isn't the file's plain text — parsing the underlying file as ordinary
        // code here could silently hide or fabricate an action-catalog connectionId.
        if (node.id && hasSemanticViteQuery(node.id)) {
            throw unsupportedModuleGraphDependency(
                normalizeDevServerModuleId(node.id),
                `Vite resource query on module id "${node.id}"`,
            );
        }

        const moduleId = node.id ? normalizeDevServerModuleId(node.id) : undefined;
        if (!moduleId || visited.has(moduleId) || !node.file) {
            continue;
        }
        visited.add(moduleId);

        if (!shouldTraverseCollectedModule(moduleId, buildRoot)) {
            continue;
        }

        let source: string;
        try {
            source = await readFile(node.file);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw unsupportedModuleGraphDependency(
                moduleId,
                `unreadable module source (${reason})`,
            );
        }

        let ast;
        try {
            const stripped = await transform(source, {
                loader: loaderForModuleId(moduleId),
                format: 'esm',
            });
            ast = parseAst(stripped.code);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw unsupportedModuleGraphDependency(
                moduleId,
                `unparseable module source (${reason})`,
            );
        }

        // `node.importedModules` mixes static and dynamic imports with no ordering guarantee,
        // but `createParsedModuleRecord` zips dependency ids positionally against the AST's
        // static import/export declarations, so this list must be static-only, same order. The
        // dev server has no Rollup-style `ModuleInfo.importedIds` outside a real build, so each
        // static specifier is resolved individually via Vite's own resolution instead — a
        // correct 1:1 correspondence by construction, since both sides derive from the same AST.
        const staticModuleSources = getStaticModuleSources(ast);
        const importerFile = node.file;
        const resolutions = await Promise.all(
            staticModuleSources.map((moduleSource) =>
                server.pluginContainer.resolveId(moduleSource, importerFile ?? undefined, {
                    ssr: true,
                }),
            ),
        );
        const staticDependencyIds = resolutions.map((resolved, index) => {
            if (!resolved) {
                // Fail closed rather than trusting an incomplete allowlist — falling back to the raw specifier text would let a connectionId-scoped call behind an unresolvable import silently drop out of extractConnectionIdsFromModuleGraph's allowlist instead of the whole request failing loudly.
                throw unsupportedModuleGraphDependency(
                    moduleId,
                    `unresolvable import specifier "${staticModuleSources[index]}"`,
                );
            }
            return normalizeDevServerModuleId(resolved.id);
        });

        const record = createParsedModuleRecord(moduleId, buildRoot, ast, staticDependencyIds);
        if (record) {
            // The dev server has no build-time `moduleParsed` hook (that's Rollup-only), so
            // nothing else re-runs the production bundle's static checks here — without this,
            // a helper module with a banned Node builtin import or restricted-global access
            // would run fine locally and only be rejected once the real build checks it at
            // publish time.
            runBackendStaticChecks(record.ast, record.id, log, record.scopeAnalysis);
            records.set(record.id, record);
        }

        for (const dependencyNode of node.importedModules) {
            pending.push(dependencyNode);
        }
    }

    return records;
}

function loaderForModuleId(moduleId: string): 'ts' | 'tsx' | 'jsx' | 'js' {
    if (moduleId.endsWith('.tsx')) {
        return 'tsx';
    }
    if (moduleId.endsWith('.ts') || moduleId.endsWith('.mts') || moduleId.endsWith('.cts')) {
        return 'ts';
    }
    if (moduleId.endsWith('.jsx')) {
        return 'jsx';
    }
    return 'js';
}

// The local-execution marker is always a literal trailing suffix (see index.ts's resolveId
// hook), never combined with another query — safe to strip by exact suffix match rather than
// blindly cutting at the first `?`, which would also discard a real Vite resource query.
function stripLocalExecutionMarker(id: string): string {
    return id.endsWith(LOCAL_EXECUTION_LOAD_SUFFIX)
        ? id.slice(0, -LOCAL_EXECUTION_LOAD_SUFFIX.length)
        : id;
}

function hasSemanticViteQuery(id: string): boolean {
    return stripLocalExecutionMarker(id).includes('?');
}

// Named distinctly from backend-module-graph-collector.ts's own normalizeViteModuleId since this
// one additionally strips the local-execution marker first — same name, different behavior, would
// invite an edit to the wrong copy. Composes with that function for the actual query-stripping so
// the two never diverge on how a Vite resource query is parsed.
function normalizeDevServerModuleId(id: string): string {
    return normalizeViteModuleId(stripLocalExecutionMarker(id));
}
