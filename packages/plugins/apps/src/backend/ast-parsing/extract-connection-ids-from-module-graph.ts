// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    analyzeActionCatalogScopes,
    findActionCatalogCallSites,
} from './action-catalog-call-sites';
import { collectActionCatalogImports } from './action-catalog-imports';
import { extractConnectionIdFromActionCallWithStaticStringResolution } from './connection-id-values';
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

    // Walk the already-parsed records from this backend entry's build. The
    // extraction cost is linear in reachable app-local modules, without
    // reparsing source files here.
    walkModuleGraph(entryId, modules, buildRoot, ({ record }) => {
        const imports = collectActionCatalogImports(record.ast);
        const scopeAnalysis = analyzeActionCatalogScopes(record.scopeAnalysis, imports);

        for (const callSite of findActionCatalogCallSites(record.ast, scopeAnalysis, record.id)) {
            const connectionId = extractConnectionIdFromActionCallWithStaticStringResolution(
                callSite,
                modules,
                record,
            );
            if (connectionId) {
                connectionIds.add(connectionId);
            }
        }
    });

    return [...connectionIds].sort();
}
