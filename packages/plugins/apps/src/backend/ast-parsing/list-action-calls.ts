// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Identifier } from 'estree';

import type { DebugBundleAction } from '../protocol';

import type { ActionCatalogCall } from './extract-connection-ids-from-module-graph';
import type { ParsedModuleRecord } from './module-graph';
import { resolveIdentifier } from './module-scope';

/**
 * Groups action-catalog calls by action FQN, with the connection IDs bound to each.
 * Returns undefined when a call has no known FQN, so a list missing it is never returned.
 */
export function listActionCalls(
    calls: ActionCatalogCall[],
    exportFqnsByModule: ReadonlyMap<string, ReadonlyMap<string, string>>,
): DebugBundleAction[] | undefined {
    const connectionIdsByFqn = new Map<string, Set<string>>();

    for (const call of calls) {
        const fqn = resolveCallFqn(call, exportFqnsByModule);
        if (!fqn) {
            return undefined;
        }
        const connectionIds = connectionIdsByFqn.get(fqn) ?? new Set<string>();
        if (call.connectionId !== undefined) {
            connectionIds.add(call.connectionId);
        }
        connectionIdsByFqn.set(fqn, connectionIds);
    }

    return [...connectionIdsByFqn]
        .map(([fqn, connectionIds]) => ({ fqn, connectionIds: [...connectionIds].sort() }))
        .sort((a, b) => (a.fqn < b.fqn ? -1 : 1));
}

function resolveCallFqn(
    { record, callSite }: ActionCatalogCall,
    exportFqnsByModule: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string | undefined {
    const { callee } = callSite;
    if (callee.type === 'Identifier') {
        const binding = getImportBinding(callee, record);
        return binding?.kind === 'named'
            ? exportFqnsByModule.get(binding.resolvedId)?.get(binding.importedName)
            : undefined;
    }
    if (
        callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        callee.property.type === 'Identifier'
    ) {
        const binding = getImportBinding(callee.object, record);
        return binding?.kind === 'namespace'
            ? exportFqnsByModule.get(binding.resolvedId)?.get(callee.property.name)
            : undefined;
    }
    return undefined;
}

function getImportBinding(identifier: Identifier, record: ParsedModuleRecord) {
    const variable = resolveIdentifier(identifier, record.scopeAnalysis);
    return variable && record.importsByVariable.get(variable);
}
