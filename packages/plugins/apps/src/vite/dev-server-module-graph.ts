// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-await-in-loop */

import { readFile } from '@dd/core/helpers/fs';
import type { Logger } from '@dd/core/types';
import { transform } from 'esbuild';
import path from 'path';
import type { EnvironmentModuleNode, ModuleNode, parseAst, ViteDevServer } from 'vite';

import type { BackendRuntime } from '../backend-runtime';
import {
    createParsedModuleRecord,
    getStaticModuleSources,
    isOutsideRoot,
    isPackageManagerModule,
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
    parse: typeof parseAst,
    runtime: BackendRuntime,
): Promise<ReadonlyMap<string, ParsedModuleRecord>> {
    const records = new Map<string, ParsedModuleRecord>();
    const staleAppModules = trackStaleAppModules(server, buildRoot);
    try {
        await walkModuleGraph(
            server,
            bareEntryId,
            buildRoot,
            log,
            parse,
            runtime,
            records,
            staleAppModules.record,
        );
    } finally {
        staleAppModules.uncache();
    }
    return records;
}

// Priming refills an edited module's transformResult, which Vite 6+'s SSR runner reads as "cached
// evaluation still current", so each stale module the walk primes is un-cached again after it.
function trackStaleAppModules(server: ViteDevServer, buildRoot: string) {
    // Vite 5 has no environment graph; its ssrLoadModule reads ssrModule, which priming never sets.
    const ssrGraph = server.environments?.ssr?.moduleGraph;
    if (!ssrGraph) {
        return { record: () => {}, uncache: () => {} };
    }
    const isStale = (node: EnvironmentModuleNode) => {
        // Untransformed and never invalidated means never run, so there's no stale evaluation.
        const wasInvalidated = node.lastInvalidationTimestamp || node.lastHMRTimestamp;
        if (!node.id || node.transformResult || !wasInvalidated) {
            return false;
        }
        // Package dependencies stay cached: re-running an SDK would drop its once-per-server setup.
        // Relative to the root so an app under node_modules still counts; outside it, the full path
        // decides, so a hoisted sibling package isn't mistaken for app code.
        const moduleId = normalizeDevServerModuleId(node.id);
        const relativePath = path.relative(buildRoot, moduleId);
        // Vite ids always use forward slashes; path.normalize gives the platform separator.
        const pathToClassify = isOutsideRoot(relativePath)
            ? path.normalize(moduleId)
            : relativePath;
        return !isPackageManagerModule(pathToClassify);
    };
    // Scanned upfront too: another plugin's transform hook can pre-transform its imports and
    // refill a stale module before the walk reaches it.
    const staleBeforeWalk = new Set<EnvironmentModuleNode>();
    ssrGraph.idToModuleMap.forEach((node) => {
        if (isStale(node)) {
            staleBeforeWalk.add(node);
        }
    });
    const primedStaleModules = new Set<EnvironmentModuleNode>();
    return {
        // Checked again right before priming, to catch a file saved mid-walk.
        record: (id: string) => {
            const node = ssrGraph.getModuleById(id);
            if (node && (staleBeforeWalk.has(node) || isStale(node))) {
                primedStaleModules.add(node);
            }
        },
        // Reverts only the priming: invalidateModule would also re-run importers that are current.
        uncache: () =>
            primedStaleModules.forEach((node) => ssrGraph.updateModuleTransformResult(node, null)),
    };
}

async function walkModuleGraph(
    server: ViteDevServer,
    bareEntryId: string,
    buildRoot: string,
    log: Logger,
    parse: typeof parseAst,
    runtime: BackendRuntime,
    records: Map<string, ParsedModuleRecord>,
    beforePrime: (id: string) => void,
): Promise<void> {
    const visited = new Set<string>();
    const pending: ModuleNode[] = [];
    const prime = async (id: string) => {
        beforePrime(id);
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
            ast = parse(stripped.code);
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
            runBackendStaticChecks(record.ast, record.id, log, record.scopeAnalysis, runtime);
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

function hasSemanticViteQuery(id: string): boolean {
    return stripLocalExecutionMarker(id).includes('?');
}

// Named distinctly from backend-module-graph-collector.ts's normalizeViteModuleId, which this
// wraps, since same-named-different-behavior would invite editing the wrong copy.
function normalizeDevServerModuleId(id: string): string {
    const unsuffixedId = stripLocalExecutionMarker(id);
    return normalizeViteModuleId(unsuffixedId);
}
