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
 * Rebuilds `createBackendModuleGraphCollector`'s `ParsedModuleRecord` map for the dev server
 * (no `moduleParsed` hook here), re-parsing each module from disk via `esbuild.transform`.
 * Primes each node via `transformRequest` (resolve + transform, never executes) before running
 * static checks, so a module can't dodge them by having `ssrLoadModule` already run its code.
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

    const entryUrl = bareEntryId + LOCAL_EXECUTION_LOAD_SUFFIX;
    await server.transformRequest(entryUrl, { ssr: true });
    const entryNode = server.moduleGraph.getModuleById(entryUrl);
    if (entryNode) {
        pending.push(entryNode);
    }

    while (pending.length > 0) {
        const node = pending.shift()!;

        const moduleId = node.id ? normalizeDevServerModuleId(node.id) : undefined;
        if (!moduleId || !node.file) {
            continue;
        }

        // Checked by normalized moduleId (extension-based), before the query check below, so a
        // non-traversable non-code import (e.g. `./template.html?raw`) is skipped like the
        // build-time collector skips it, regardless of its query.
        if (!shouldTraverseCollectedModule(moduleId, buildRoot)) {
            continue;
        }

        // Checked before the visited-set dedup below: a query'd id and its plain counterpart
        // normalize to the same moduleId, so deduping first would let a query'd form silently
        // skip this check once the plain form had already been visited.
        if (node.id && hasSemanticViteQuery(node.id)) {
            throw unsupportedModuleGraphDependency(
                moduleId,
                `Vite resource query on module id "${node.id}"`,
            );
        }

        if (visited.has(moduleId)) {
            continue;
        }
        visited.add(moduleId);

        // Known, accepted gap: reads straight from disk, so a project's own `load`/`transform`
        // hook rewriting this file is invisible here. `transformRequest`'s output isn't usable
        // instead — it already carries Vite's SSR import-rewrite, which our parser can't read.
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

        // `createParsedModuleRecord` zips dependency ids positionally against the AST's static
        // imports, so this list must be static-only, same order — resolved individually since
        // the dev server has no Rollup-style `ModuleInfo.importedIds`.
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
                // Fail closed — falling back to the raw specifier would let a connectionId
                // silently drop out of the allowlist instead of failing loudly.
                throw unsupportedModuleGraphDependency(
                    moduleId,
                    `unresolvable import specifier "${staticModuleSources[index]}"`,
                );
            }
            return normalizeDevServerModuleId(resolved.id);
        });

        const record = createParsedModuleRecord(moduleId, buildRoot, ast, staticDependencyIds);
        if (record) {
            // No build-time moduleParsed hook here (Rollup-only), so this is what catches a
            // banned import or restricted global locally instead of only at publish time.
            runBackendStaticChecks(record.ast, record.id, log, record.scopeAnalysis);
            records.set(record.id, record);
        }

        for (const dependencyNode of node.importedModules) {
            // Primes this dependency's own `importedModules` before it's dequeued, the same
            // non-evaluating priming the entry got above — so no node in the traversal is ever
            // read before it has itself gone through this same transform-only step.
            if (dependencyNode.id) {
                await server.transformRequest(dependencyNode.id, { ssr: true });
            }
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

// The marker is always a literal trailing suffix, never combined with another query — exact
// suffix match, not cutting at the first `?`, which would also discard a real resource query.
function stripLocalExecutionMarker(id: string): string {
    return id.endsWith(LOCAL_EXECUTION_LOAD_SUFFIX)
        ? id.slice(0, -LOCAL_EXECUTION_LOAD_SUFFIX.length)
        : id;
}

function hasSemanticViteQuery(id: string): boolean {
    return stripLocalExecutionMarker(id).includes('?');
}

// Named distinctly from backend-module-graph-collector.ts's normalizeViteModuleId, which this
// wraps, since same-named-different-behavior would invite editing the wrong copy.
function normalizeDevServerModuleId(id: string): string {
    const unsuffixedId = stripLocalExecutionMarker(id);
    return normalizeViteModuleId(unsuffixedId);
}
