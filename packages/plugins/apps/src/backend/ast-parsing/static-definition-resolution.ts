// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type * as eslintScope from 'eslint-scope';
import type { Identifier } from 'estree';

import type {
    ConstStaticBinding,
    ExportBinding,
    ImportBinding,
    MutableStaticBinding,
    ParsedModuleRecord,
} from './module-graph';
import { resolveIdentifier } from './module-scope';

export type StaticDefinition = LocalStaticDefinition | UnsupportedStaticDefinition;

export interface LocalStaticDefinition {
    kind: 'local';
    moduleId: string;
    variable: eslintScope.Variable;
    binding: ConstStaticBinding;
    hops: StaticDefinitionHop[];
}

export type UnsupportedStaticDefinition =
    | AmbiguousStarExportStaticDefinition
    | CycleStaticDefinition
    | DefaultExportStaticDefinition
    | DefaultImportStaticDefinition
    | MissingExportStaticDefinition
    | MissingModuleRecordForExportStaticDefinition
    | MissingModuleRecordForVariableStaticDefinition
    | MissingStaticBindingStaticDefinition
    | MutableBindingStaticDefinition
    | NamespaceImportStaticDefinition
    | UnresolvedIdentifierStaticDefinition
    | UnsupportedBindingStaticDefinition
    | UnsupportedExportStaticDefinition;

export type StaticDefinitionUnsupportedReason = UnsupportedStaticDefinition['reason'];

interface UnsupportedStaticDefinitionBase {
    kind: 'unsupported';
    moduleId: string;
    message: string;
    hops: StaticDefinitionHop[];
}

export interface AmbiguousStarExportStaticDefinition extends UnsupportedStaticDefinitionBase {
    reason: 'ambiguous-star-export';
    exportName: string;
}

export interface CycleStaticDefinition extends UnsupportedStaticDefinitionBase {
    reason: 'cycle';
    exportName: string;
}

export interface DefaultExportStaticDefinition extends UnsupportedStaticDefinitionBase {
    reason: 'default-export';
    exportName: string;
}

export interface DefaultImportStaticDefinition extends UnsupportedStaticDefinitionBase {
    reason: 'default-import';
    variableName: string;
}

export interface MissingExportStaticDefinition extends UnsupportedStaticDefinitionBase {
    reason: 'missing-export';
    exportName: string;
}

export interface MissingModuleRecordForExportStaticDefinition
    extends UnsupportedStaticDefinitionBase {
    reason: 'missing-module-record';
    requestKind: 'export';
    exportName: string;
}

export interface MissingModuleRecordForVariableStaticDefinition
    extends UnsupportedStaticDefinitionBase {
    reason: 'missing-module-record';
    requestKind: 'variable';
    variableName: string;
}

export interface MissingStaticBindingStaticDefinition extends UnsupportedStaticDefinitionBase {
    reason: 'missing-static-binding';
    variableName: string;
}

export interface MutableBindingStaticDefinition extends UnsupportedStaticDefinitionBase {
    reason: 'mutable-binding';
    variableName: string;
    declarationKind: MutableStaticBinding['declarationKind'];
}

export interface NamespaceImportStaticDefinition extends UnsupportedStaticDefinitionBase {
    reason: 'namespace-import';
    variableName: string;
}

export interface UnresolvedIdentifierStaticDefinition extends UnsupportedStaticDefinitionBase {
    reason: 'unresolved-identifier';
    variableName: string;
}

export interface UnsupportedBindingStaticDefinition extends UnsupportedStaticDefinitionBase {
    reason: 'unsupported-binding';
    variableName: string;
    bindingReason: string;
}

export interface UnsupportedExportStaticDefinition extends UnsupportedStaticDefinitionBase {
    reason: 'unsupported-export';
    exportName: string;
    exportReason: string;
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
        return unsupportedMissingModuleRecordForVariable(moduleId, [], identifier.name);
    }

    const variable = resolveIdentifier(identifier, record.scopeAnalysis);
    if (!variable) {
        // Example: request({ connectionId: HTTP_ID }); when HTTP_ID is not in scope.
        return unsupportedUnresolvedIdentifier(moduleId, [], identifier.name);
    }
    if (isDefinitionIdentifier(identifier, variable)) {
        // Example: const HTTP_ID = 'conn-http'; when HTTP_ID is the declaration itself.
        return unsupportedUnresolvedIdentifier(moduleId, [], identifier.name);
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
        return unsupportedMissingModuleRecordForExport(moduleId, hops, exportName);
    }

    if (exportName === 'default') {
        // Example: export { default as HTTP_ID } from './ids.js';
        return unsupportedDefaultExport(moduleId, hops, exportName);
    }

    const visitKey = `${moduleId}\0${exportName}`;
    if (state.visitedExports.has(visitKey)) {
        // Example: export * from './index.js'; when index.js eventually points back here.
        return unsupportedCycle(moduleId, hops, exportName);
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
        // Example: export * as ids from './ids.js';
        return unsupportedExport(record.id, hops, exportName, binding.reason);
    }

    if (binding.kind === 're-export') {
        if (binding.importedName === 'default') {
            // Example: export { default as HTTP_ID } from './ids.js';
            return unsupportedDefaultExport(record.id, hops, exportName);
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

        if (candidate && isSameLocalDefinition(candidate, result)) {
            continue;
        }

        if (candidate) {
            // Example: export * from './one.js'; export * from './two.js';
            return unsupportedAmbiguousStarExport(record.id, hops, exportName);
        }
        candidate = result;
    }

    // Example: export * from './ids.js'; when ids.js does not export HTTP_ID.
    return candidate ?? unsupportedMissingExport(record.id, hops, exportName);
}

function isSameLocalDefinition(left: LocalStaticDefinition, right: LocalStaticDefinition): boolean {
    return left.moduleId === right.moduleId && left.variable === right.variable;
}

function resolveVariable(
    state: ResolverState,
    moduleId: string,
    variable: eslintScope.Variable,
    hops: StaticDefinitionHop[],
): StaticDefinition {
    const record = state.modules.get(moduleId);
    if (!record) {
        // Example: resolving HTTP_ID after following an import to a module that was not collected.
        return unsupportedMissingModuleRecordForVariable(moduleId, hops, variable.name);
    }

    const importBinding = record.importsByVariable.get(variable);
    if (importBinding) {
        return resolveImportBinding(state, record.id, variable.name, importBinding, hops);
    }

    const binding = record.topLevelBindingsByVariable.get(variable);
    if (!binding) {
        // Example: export { HTTP_ID }; when HTTP_ID is not a recorded top-level binding.
        return unsupportedMissingStaticBinding(record.id, hops, variable.name);
    }

    if (binding.kind === 'const') {
        return { kind: 'local', moduleId: record.id, variable, binding, hops };
    }

    if (binding.kind === 'mutable') {
        // Example: export let HTTP_ID = 'conn-http';
        return unsupportedMutableBinding(record.id, hops, variable.name, binding.declarationKind);
    }

    // Example: export function getId() { return 'conn-http'; }
    return unsupportedBinding(record.id, hops, variable.name, binding.reason);
}

function resolveImportBinding(
    state: ResolverState,
    moduleId: string,
    localName: string,
    binding: ImportBinding,
    hops: StaticDefinitionHop[],
): StaticDefinition {
    if (binding.kind === 'default') {
        // Example: import HTTP_ID from './ids.js';
        return unsupportedDefaultImport(moduleId, hops, localName);
    }

    if (binding.kind === 'namespace') {
        // Example: import * as ids from './ids.js';
        return unsupportedNamespaceImport(moduleId, hops, localName);
    }

    if (binding.importedName === 'default') {
        // Example: import { default as HTTP_ID } from './ids.js';
        return unsupportedDefaultImport(moduleId, hops, localName);
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

function unsupportedAmbiguousStarExport(
    moduleId: string,
    hops: StaticDefinitionHop[],
    exportName: string,
): AmbiguousStarExportStaticDefinition {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'ambiguous-star-export',
        exportName,
        message: `Module '${moduleId}' exposes ambiguous star exports for '${exportName}'.`,
        hops,
    };
}

function unsupportedCycle(
    moduleId: string,
    hops: StaticDefinitionHop[],
    exportName: string,
): CycleStaticDefinition {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'cycle',
        exportName,
        message: `Resolving export '${exportName}' from module '${moduleId}' would cycle through the module graph.`,
        hops,
    };
}

function unsupportedDefaultExport(
    moduleId: string,
    hops: StaticDefinitionHop[],
    exportName: string,
): DefaultExportStaticDefinition {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'default-export',
        exportName,
        message: `Export '${exportName}' from module '${moduleId}' resolves through an unsupported default export.`,
        hops,
    };
}

function unsupportedDefaultImport(
    moduleId: string,
    hops: StaticDefinitionHop[],
    variableName: string,
): DefaultImportStaticDefinition {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'default-import',
        variableName,
        message: `Variable '${variableName}' in module '${moduleId}' is an unsupported default import.`,
        hops,
    };
}

function unsupportedMissingExport(
    moduleId: string,
    hops: StaticDefinitionHop[],
    exportName: string,
): MissingExportStaticDefinition {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'missing-export',
        exportName,
        message: `Module '${moduleId}' does not expose export '${exportName}'.`,
        hops,
    };
}

function unsupportedMissingModuleRecordForExport(
    moduleId: string,
    hops: StaticDefinitionHop[],
    exportName: string,
): MissingModuleRecordForExportStaticDefinition {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'missing-module-record',
        requestKind: 'export',
        exportName,
        message: `Module '${moduleId}' was not collected while resolving export '${exportName}'.`,
        hops,
    };
}

function unsupportedMissingModuleRecordForVariable(
    moduleId: string,
    hops: StaticDefinitionHop[],
    variableName: string,
): MissingModuleRecordForVariableStaticDefinition {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'missing-module-record',
        requestKind: 'variable',
        variableName,
        message: `Module '${moduleId}' was not collected while resolving variable '${variableName}'.`,
        hops,
    };
}

function unsupportedMissingStaticBinding(
    moduleId: string,
    hops: StaticDefinitionHop[],
    variableName: string,
): MissingStaticBindingStaticDefinition {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'missing-static-binding',
        variableName,
        message: `Variable '${variableName}' in module '${moduleId}' does not have a recorded top-level static binding.`,
        hops,
    };
}

function unsupportedMutableBinding(
    moduleId: string,
    hops: StaticDefinitionHop[],
    variableName: string,
    declarationKind: MutableStaticBinding['declarationKind'],
): MutableBindingStaticDefinition {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'mutable-binding',
        variableName,
        declarationKind,
        message: `Variable '${variableName}' in module '${moduleId}' is declared with mutable '${declarationKind}'.`,
        hops,
    };
}

function unsupportedNamespaceImport(
    moduleId: string,
    hops: StaticDefinitionHop[],
    variableName: string,
): NamespaceImportStaticDefinition {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'namespace-import',
        variableName,
        message: `Variable '${variableName}' in module '${moduleId}' is an unsupported namespace import.`,
        hops,
    };
}

function unsupportedUnresolvedIdentifier(
    moduleId: string,
    hops: StaticDefinitionHop[],
    variableName: string,
): UnresolvedIdentifierStaticDefinition {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'unresolved-identifier',
        variableName,
        message: `Identifier '${variableName}' in module '${moduleId}' is not a resolvable reference.`,
        hops,
    };
}

function unsupportedBinding(
    moduleId: string,
    hops: StaticDefinitionHop[],
    variableName: string,
    bindingReason: string,
): UnsupportedBindingStaticDefinition {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'unsupported-binding',
        variableName,
        bindingReason,
        message: `Variable '${variableName}' in module '${moduleId}' has unsupported binding: ${bindingReason}.`,
        hops,
    };
}

function unsupportedExport(
    moduleId: string,
    hops: StaticDefinitionHop[],
    exportName: string,
    exportReason: string,
): UnsupportedExportStaticDefinition {
    return {
        kind: 'unsupported',
        moduleId,
        reason: 'unsupported-export',
        exportName,
        exportReason,
        message: `Export '${exportName}' from module '${moduleId}' is unsupported: ${exportReason}.`,
        hops,
    };
}
