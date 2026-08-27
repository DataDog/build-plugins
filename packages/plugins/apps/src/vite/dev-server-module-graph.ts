// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parseAst } from 'rollup/parseAst';
import type { ModuleNode, ViteDevServer } from 'vite';

import {
    createParsedModuleRecord,
    type ParsedModuleRecord,
    shouldTraverseCollectedModule,
    unsupportedModuleGraphDependency,
} from '../backend/ast-parsing/module-graph';
import { LOCAL_EXECUTION_LOAD_SUFFIX } from '../constants';

/**
 * Builds the same `ReadonlyMap<string, ParsedModuleRecord>` shape
 * `createBackendModuleGraphCollector`'s `moduleParsed` hook produces during a
 * real Rollup build — but for the dev server, where `moduleParsed` never
 * fires at all (it's a Rollup-build-only hook; Vite's dev-server plugin
 * container doesn't implement it). Instead, this walks Vite's own
 * `server.moduleGraph`, which the dev server already populates as a side
 * effect of `ssrLoadModule`: by the time an `await server.ssrLoadModule(id)`
 * call resolves, the entry's `ModuleNode.importedModules` — and every
 * imported module's own `importedModules` — already reflect the full
 * transitive static-import graph, recursively, with no extra ticks needed.
 *
 * Call this only after `loadModule` has resolved for `bareEntryId +
 * LOCAL_EXECUTION_LOAD_SUFFIX` in the same request — the graph it reads is a
 * live side effect of that call, not independently maintained state.
 * `bareEntryId` is the same unsuffixed id `extractConnectionIdsFromModuleGraph`
 * needs to key into the returned map below; the suffix is appended here,
 * internally, rather than left to each caller to remember — Vite keys the
 * node it just loaded by the full resolved id (suffix included), since it
 * treats each distinct query string as a logically distinct module.
 */
export function collectModuleGraphFromServer(
    server: ViteDevServer,
    bareEntryId: string,
    buildRoot: string,
): ReadonlyMap<string, ParsedModuleRecord> {
    const records = new Map<string, ParsedModuleRecord>();
    const visited = new Set<string>();
    const pending: ModuleNode[] = [];

    const entryNode = server.moduleGraph.getModuleById(bareEntryId + LOCAL_EXECUTION_LOAD_SUFFIX);
    if (entryNode) {
        pending.push(entryNode);
    }

    while (pending.length > 0) {
        const node = pending.shift()!;
        const moduleId = node.id ? normalizeViteModuleId(node.id) : undefined;
        if (!moduleId || visited.has(moduleId)) {
            continue;
        }
        visited.add(moduleId);

        if (!shouldTraverseCollectedModule(moduleId, buildRoot)) {
            continue;
        }

        // `transformResult` is the client/browser transform; SSR loads (what
        // local execution always is, via server.ssrLoadModule) populate
        // `ssrTransformResult` instead. Neither exists yet if Vite hasn't
        // transformed this module — a local dependency the caller's own
        // ssrLoadModule call never actually reached.
        const transformResult = node.ssrTransformResult ?? node.transformResult;
        if (typeof transformResult?.code !== 'string') {
            continue;
        }

        let ast;
        try {
            ast = parseAst(transformResult.code);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw unsupportedModuleGraphDependency(
                moduleId,
                `unparseable module source (${reason})`,
            );
        }

        // `deps` are this module's own static imports, already resolved to
        // real module ids by Vite's import-analysis plugin — the SSR
        // equivalent of `moduleParsed`'s `importedIds`/
        // `importedIdResolutions`. `dynamicDeps` (deliberately unused here)
        // folds in `import()` calls; `module-graph.ts`'s own AST walk is what
        // flags those as unsupported, so only static deps belong here.
        const staticDependencyIds = (transformResult.deps ?? []).map(normalizeViteModuleId);

        const record = createParsedModuleRecord(moduleId, buildRoot, ast, staticDependencyIds);
        if (record) {
            records.set(record.id, record);
        }

        for (const dependencyId of staticDependencyIds) {
            const dependencyNode = server.moduleGraph.getModuleById(dependencyId);
            if (dependencyNode) {
                pending.push(dependencyNode);
            }
        }
    }

    return records;
}

function normalizeViteModuleId(id: string): string {
    return id.split('?')[0];
}
