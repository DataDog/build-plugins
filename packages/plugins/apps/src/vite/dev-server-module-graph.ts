// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-await-in-loop */

import { readFile } from '@dd/core/helpers/fs';
import type { Logger } from '@dd/core/types';
import { transform } from 'esbuild';
import type { ModuleNode, parseAst, ViteDevServer } from 'vite';

import {
    createParsedModuleRecord,
    type ParsedModuleRecord,
    resolveStaticModuleSources,
    unsupportedModuleGraphDependency,
} from '../backend/ast-parsing/module-graph';
import { runBackendStaticChecks } from '../backend/ast-parsing/run-backend-static-checks';
import { isBackendSourceModule } from '../backend/backend-sources';
import { LOCAL_EXECUTION_LOAD_SUFFIX } from '../constants';

import { normalizeViteModuleId } from './backend-module-graph-collector';

/**
 * Rebuilds `createBackendModuleGraphCollector`'s `ParsedModuleRecord` map for the dev server
 * (no `moduleParsed` hook here), re-parsing each module from disk via `esbuild.transform`.
 * Primes each node via `transformRequest` (resolve + transform, never executes), so its imports
 * are known and checked before a call's process runs any of its code.
 */
export async function collectModuleGraphFromServer(
    server: ViteDevServer,
    bareEntryId: string,
    buildRoot: string,
    log: Logger,
    parse: typeof parseAst,
): Promise<ReadonlyMap<string, ParsedModuleRecord>> {
    const records = new Map<string, ParsedModuleRecord>();
    await walkModuleGraph(server, bareEntryId, buildRoot, log, parse, records);
    return records;
}

async function walkModuleGraph(
    server: ViteDevServer,
    bareEntryId: string,
    buildRoot: string,
    log: Logger,
    parse: typeof parseAst,
    records: Map<string, ParsedModuleRecord>,
): Promise<void> {
    const visited = new Set<string>();
    const pending: ModuleNode[] = [];
    const prime = async (id: string) => {
        await server.transformRequest(id, { ssr: true });
    };

    const entryUrl = bareEntryId + LOCAL_EXECUTION_LOAD_SUFFIX;
    await prime(entryUrl);
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
        if (!isBackendSourceModule(moduleId, buildRoot)) {
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
            ast = parse(stripped.code);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw unsupportedModuleGraphDependency(
                moduleId,
                `unparseable module source (${reason})`,
            );
        }

        const importerFile = node.file;
        const staticDependencies = await resolveStaticModuleSources(
            ast,
            moduleId,
            async (moduleSource) => {
                const resolved = await server.pluginContainer.resolveId(
                    moduleSource,
                    importerFile,
                    {
                        ssr: true,
                    },
                );
                return resolved ? normalizeDevServerModuleId(resolved.id) : null;
            },
        );

        const record = createParsedModuleRecord(moduleId, buildRoot, ast, staticDependencies);
        if (record) {
            // No build-time moduleParsed hook here (Rollup-only), so this is what catches a
            // restricted global locally instead of only at publish time.
            runBackendStaticChecks(record.ast, record.id, log, record.scopeAnalysis);
            records.set(record.id, record);
        }

        for (const dependencyNode of node.importedModules) {
            // Primes this dependency's own `importedModules` before it's dequeued, the same
            // non-evaluating priming the entry got above — so no node in the traversal is ever
            // read before it has itself gone through this same transform-only step.
            if (dependencyNode.id) {
                await prime(dependencyNode.id);
            }
            pending.push(dependencyNode);
        }
    }
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

// Vite's `v=<hash>` (added to installed modules' ids once a deps optimizer runs) is only a cache
// key; any other query parameter could change what the module is.
function hasSemanticViteQuery(id: string): boolean {
    const [, query = ''] = stripLocalExecutionMarker(id).split(/\?(.*)/s);
    return query.split('&').some((param) => param !== '' && !/^v=[\w.-]+$/.test(param));
}

// Named distinctly from backend-module-graph-collector.ts's normalizeViteModuleId, which this
// wraps, since same-named-different-behavior would invite editing the wrong copy.
function normalizeDevServerModuleId(id: string): string {
    const unsuffixedId = stripLocalExecutionMarker(id);
    return normalizeViteModuleId(unsuffixedId);
}
