// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    type ParsedModuleRecord,
    shouldTraverseCollectedModule,
    unsupportedModuleGraphDependency,
} from './module-graph';

export interface ModuleGraphWalkContext {
    entryId: string;
    moduleId: string;
    record: ParsedModuleRecord;
}

/**
 * Walks every collected app-local module statically reachable from a backend
 * entry and applies fail-closed graph validation before following dependency
 * edges.
 */
export function walkModuleGraph(
    entryId: string,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    buildRoot: string,
    visit: (context: ModuleGraphWalkContext) => void,
): void {
    // Traverse from the real backend entry, not the virtual wrapper used by
    // the backend build. Every backend export in this file receives this same
    // conservative file-level allowlist.
    const pending = [entryId];
    const visited = new Set<string>();

    while (pending.length > 0) {
        // Process each collected module at most once so local cycles cannot
        // loop forever.
        const moduleId = pending.shift()!;
        if (visited.has(moduleId)) {
            continue;
        }
        visited.add(moduleId);

        // A reachable local module that Rollup did not parse means the
        // collected graph is incomplete, so fail closed instead of silently
        // omitting a possible connection ID.
        const record = modules.get(moduleId);
        if (!record) {
            throw unsupportedModuleGraphDependency(
                entryId,
                `missing module record for ${moduleId}`,
            );
        }

        visit({ entryId, moduleId, record });

        // Dynamic local imports and local require calls can hide reachable
        // action-catalog calls from static traversal. Treat them as unsupported
        // graph shapes for this PR.
        for (const dependency of record.unsupportedDependencies) {
            throw unsupportedModuleGraphDependency(
                entryId,
                `${dependency.kind} ${dependency.specifier}`,
            );
        }

        // Follow only collected local source modules. Package imports, virtual
        // entries, generated files, and files outside buildRoot are ignored by
        // design because they are outside the app-local backend graph.
        for (const dependencyId of record.staticDependencies) {
            if (!shouldTraverseCollectedModule(dependencyId, buildRoot)) {
                continue;
            }

            // A local dependency can be statically reachable but absent from
            // the collector if Rollup did not parse it. Fail closed rather than
            // trusting an incomplete allowlist.
            if (!modules.has(dependencyId)) {
                throw unsupportedModuleGraphDependency(
                    entryId,
                    `uncollected local import ${dependencyId} from ${record.id}`,
                );
            }

            pending.push(dependencyId);
        }
    }
}
