// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type * as eslintScope from 'eslint-scope';
import type { Identifier } from 'estree';

import type {
    ConstStaticBinding,
    ExportBinding,
    ImportBinding,
    ParsedModuleRecord,
} from './module-graph';
import { resolveIdentifier } from './module-scope';

export type StaticDefinitionUnsupportedReason =
    | 'ambiguous-star-export'
    | 'cycle'
    | 'default-export'
    | 'default-import'
    | 'missing-export'
    | 'missing-module-record'
    | 'missing-static-binding'
    | 'mutable-binding'
    | 'namespace-import'
    | 'unresolved-identifier'
    | 'unsupported-binding'
    | 'unsupported-export';

export type StaticDefinition = LocalStaticDefinition | UnsupportedStaticDefinition;

export interface LocalStaticDefinition {
    kind: 'local';
    moduleId: string;
    variable: eslintScope.Variable;
    binding: ConstStaticBinding;
    hops: StaticDefinitionHop[];
}

export interface UnsupportedStaticDefinition {
    kind: 'unsupported';
    moduleId: string;
    reason: StaticDefinitionUnsupportedReason;
    exportName?: string;
    variableName?: string;
    detail?: string;
    hops: StaticDefinitionHop[];
}

export type StaticDefinitionHop =
    | ImportStaticDefinitionHop
    | LocalExportStaticDefinitionHop
    | ReExportStaticDefinitionHop
    | StarExportStaticDefinitionHop;

export interface ImportStaticDefinitionHop {
    kind: 'import';
    moduleId: string;
    localName: string;
    exportName: string;
    sourceModuleId: string;
}

export interface LocalExportStaticDefinitionHop {
    kind: 'local-export';
    moduleId: string;
    exportName: string;
    localName: string;
}

export interface ReExportStaticDefinitionHop {
    kind: 're-export';
    moduleId: string;
    exportName: string;
    sourceModuleId: string;
    sourceExportName: string;
}

export interface StarExportStaticDefinitionHop {
    kind: 'star-export';
    moduleId: string;
    exportName: string;
    sourceModuleId: string;
}

interface ResolverState {
    modules: ReadonlyMap<string, ParsedModuleRecord>;
    visitedExports: Set<string>;
}

export function resolveStaticDefinitionForIdentifier(
    modules: ReadonlyMap<string, ParsedModuleRecord>,
    moduleId: string,
    identifier: Identifier,
): StaticDefinition {
    const record = modules.get(moduleId);
    if (!record) {
        return unsupported(moduleId, 'missing-module-record', [], {
            variableName: identifier.name,
        });
    }

    const variable = resolveIdentifier(identifier, record.scopeAnalysis);
    if (!variable) {
        return unsupported(moduleId, 'unresolved-identifier', [], {
            variableName: identifier.name,
        });
    }
    if (isDefinitionIdentifier(identifier, variable)) {
        return unsupported(moduleId, 'unresolved-identifier', [], {
            variableName: identifier.name,
        });
    }

    return resolveVariable({ modules, visitedExports: new Set() }, moduleId, variable, []);
}

function isDefinitionIdentifier(identifier: Identifier, variable: eslintScope.Variable): boolean {
    return variable.defs.some((definition) => definition.name === identifier);
}

function resolveExport(
    state: ResolverState,
    moduleId: string,
    exportName: string,
    hops: StaticDefinitionHop[],
): StaticDefinition {
    const record = state.modules.get(moduleId);
    if (!record) {
        return unsupported(moduleId, 'missing-module-record', hops, { exportName });
    }

    if (exportName === 'default') {
        return unsupported(moduleId, 'default-export', hops, { exportName });
    }

    const visitKey = `${moduleId}\0${exportName}`;
    if (state.visitedExports.has(visitKey)) {
        return unsupported(moduleId, 'cycle', hops, { exportName });
    }

    state.visitedExports.add(visitKey);
    try {
        const explicitExport = record.exportsByName.get(exportName);
        if (explicitExport) {
            return resolveExplicitExport(state, record, exportName, explicitExport, hops);
        }

        return resolveStarExport(state, record, exportName, hops);
    } finally {
        state.visitedExports.delete(visitKey);
    }
}

function resolveExplicitExport(
    state: ResolverState,
    record: ParsedModuleRecord,
    exportName: string,
    binding: ExportBinding,
    hops: StaticDefinitionHop[],
): StaticDefinition {
    if (binding.kind === 'unsupported') {
        return unsupported(record.id, 'unsupported-export', hops, {
            exportName,
            detail: binding.reason,
        });
    }

    if (binding.kind === 're-export') {
        if (binding.importedName === 'default') {
            return unsupported(record.id, 'default-export', hops, { exportName });
        }

        return resolveExport(state, binding.resolvedId, binding.importedName, [
            ...hops,
            {
                kind: 're-export',
                moduleId: record.id,
                exportName,
                sourceModuleId: binding.resolvedId,
                sourceExportName: binding.importedName,
            },
        ]);
    }

    return resolveVariable(state, record.id, binding.variable, [
        ...hops,
        {
            kind: 'local-export',
            moduleId: record.id,
            exportName,
            localName: binding.variable.name,
        },
    ]);
}

function resolveStarExport(
    state: ResolverState,
    record: ParsedModuleRecord,
    exportName: string,
    hops: StaticDefinitionHop[],
): StaticDefinition {
    let candidate: LocalStaticDefinition | undefined;

    for (const starExport of record.starExports) {
        const result = resolveExport(state, starExport.resolvedId, exportName, [
            ...hops,
            {
                kind: 'star-export',
                moduleId: record.id,
                exportName,
                sourceModuleId: starExport.resolvedId,
            },
        ]);

        if (result.kind === 'unsupported') {
            if (result.reason === 'missing-export') {
                continue;
            }

            return result;
        }

        if (candidate) {
            return unsupported(record.id, 'ambiguous-star-export', hops, { exportName });
        }
        candidate = result;
    }

    return candidate ?? unsupported(record.id, 'missing-export', hops, { exportName });
}

function resolveVariable(
    state: ResolverState,
    moduleId: string,
    variable: eslintScope.Variable,
    hops: StaticDefinitionHop[],
): StaticDefinition {
    const record = state.modules.get(moduleId);
    if (!record) {
        return unsupported(moduleId, 'missing-module-record', hops, {
            variableName: variable.name,
        });
    }

    const importBinding = record.importsByVariable.get(variable);
    if (importBinding) {
        return resolveImportBinding(state, record.id, variable.name, importBinding, hops);
    }

    const binding = record.topLevelBindingsByVariable.get(variable);
    if (!binding) {
        return unsupported(record.id, 'missing-static-binding', hops, {
            variableName: variable.name,
        });
    }

    if (binding.kind === 'const') {
        return { kind: 'local', moduleId: record.id, variable, binding, hops };
    }

    if (binding.kind === 'mutable') {
        return unsupported(record.id, 'mutable-binding', hops, {
            variableName: variable.name,
            detail: binding.declarationKind,
        });
    }

    return unsupported(record.id, 'unsupported-binding', hops, {
        variableName: variable.name,
        detail: binding.reason,
    });
}

function resolveImportBinding(
    state: ResolverState,
    moduleId: string,
    localName: string,
    binding: ImportBinding,
    hops: StaticDefinitionHop[],
): StaticDefinition {
    if (binding.kind === 'default') {
        return unsupported(moduleId, 'default-import', hops, { variableName: localName });
    }

    if (binding.kind === 'namespace') {
        return unsupported(moduleId, 'namespace-import', hops, { variableName: localName });
    }

    if (binding.importedName === 'default') {
        return unsupported(moduleId, 'default-import', hops, { variableName: localName });
    }

    return resolveExport(state, binding.resolvedId, binding.importedName, [
        ...hops,
        {
            kind: 'import',
            moduleId,
            localName,
            exportName: binding.importedName,
            sourceModuleId: binding.resolvedId,
        },
    ]);
}

function unsupported(
    moduleId: string,
    reason: StaticDefinitionUnsupportedReason,
    hops: StaticDefinitionHop[],
    context: {
        exportName?: string;
        variableName?: string;
        detail?: string;
    } = {},
): UnsupportedStaticDefinition {
    return {
        kind: 'unsupported',
        moduleId,
        reason,
        ...context,
        hops,
    };
}
