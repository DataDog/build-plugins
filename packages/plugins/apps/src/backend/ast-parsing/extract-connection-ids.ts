// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode } from 'estree';

import {
    analyzeActionCatalogScopes,
    findActionCatalogCallSites,
} from './action-catalog-call-sites';
import { collectActionCatalogImports } from './action-catalog-imports';
import {
    collectSameModuleConnectionIdBindings,
    extractConnectionIdFromActionCall,
} from './connection-id-values';
import type { ParsedModuleRecord } from './module-graph';
import { analyzeModuleScope } from './module-scope';
import { ensureProgram } from './type-guards';

export interface ConnectionIdExtractionContext {
    modules: ReadonlyMap<string, ParsedModuleRecord>;
    record: ParsedModuleRecord;
}

export function extractConnectionIds(
    ast: BaseNode,
    filePath: string,
    context?: ConnectionIdExtractionContext,
): string[] {
    const program = ensureProgram(ast, filePath);

    const imports = collectActionCatalogImports(program);
    const moduleScope = context?.record.scopeAnalysis ?? analyzeModuleScope(program);
    const scopeAnalysis = analyzeActionCatalogScopes(moduleScope, imports);
    const bindings = collectSameModuleConnectionIdBindings(program, moduleScope);
    const connectionIds = new Set<string>();
    const moduleGraph = context
        ? { modules: context.modules, moduleId: context.record.id }
        : undefined;

    for (const callSite of findActionCatalogCallSites(program, scopeAnalysis, filePath)) {
        const connectionId = extractConnectionIdFromActionCall(
            callSite,
            bindings,
            moduleScope,
            filePath,
            moduleGraph,
        );
        if (connectionId) {
            connectionIds.add(connectionId);
        }
    }

    return [...connectionIds].sort();
}
