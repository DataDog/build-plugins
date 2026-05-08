// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode } from 'estree';

import {
    analyzeActionCatalogScopes,
    findActionCatalogCallSites,
} from './action-catalog-call-sites';
import { collectActionCatalogImports, hasActionCatalogImports } from './action-catalog-imports';
import {
    collectSameModuleConnectionIdBindings,
    extractConnectionIdFromActionCall,
} from './connection-id-values';
import { isProgramNode } from './type-guards';

export function extractConnectionIds(ast: BaseNode, filePath: string): string[] {
    if (!isProgramNode(ast)) {
        throw new Error(
            `Expected a Program node from this.parse() for ${filePath}, got ${ast.type}`,
        );
    }

    const imports = collectActionCatalogImports(ast);
    if (!hasActionCatalogImports(imports)) {
        return [];
    }

    const scopeAnalysis = analyzeActionCatalogScopes(ast, imports);
    const bindings = collectSameModuleConnectionIdBindings(ast, scopeAnalysis);
    const connectionIds = new Set<string>();

    for (const callSite of findActionCatalogCallSites(ast, scopeAnalysis, filePath)) {
        const connectionId = extractConnectionIdFromActionCall(
            callSite,
            bindings,
            scopeAnalysis,
            filePath,
        );
        if (connectionId) {
            connectionIds.add(connectionId);
        }
    }

    return [...connectionIds].sort();
}
