// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { extractConnectionIds } from './extract-connection-ids';
import type { ParsedModuleRecord } from './module-graph';
import { walkModuleGraph } from './walk-module-graph';

/**
 * Extracts the conservative backend-file connection ID union from module records
 * collected while the backend bundler walked the real execution graph.
 */
export function extractConnectionIdsFromModuleGraph(
    entryId: string,
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    buildRoot: string,
): string[] {
    const connectionIds = new Set<string>();

    walkModuleGraph(entryId, modules, buildRoot, ({ moduleId, record }) => {
        // Resolve connection IDs while visiting the reachable graph so this
        // step can later receive graph-aware value-resolution context.
        const moduleConnectionIds = extractConnectionIds(record.ast, moduleId);
        for (const connectionId of moduleConnectionIds) {
            connectionIds.add(connectionId);
        }
    });

    return [...connectionIds].sort();
}
