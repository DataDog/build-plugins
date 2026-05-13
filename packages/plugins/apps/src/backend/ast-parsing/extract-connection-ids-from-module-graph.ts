// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type * as eslintScope from 'eslint-scope';

import {
    analyzeActionCatalogScopes,
    findActionCatalogCallSites,
    type ScopeAnalysis,
} from './action-catalog-call-sites';
import { collectActionCatalogImports } from './action-catalog-imports';
import {
    collectSameModuleConnectionIdBindings,
    extractConnectionIdFromActionCall,
    resolveConnectionIdValue,
    resolveObjectExpressionValue,
    unsupportedConnectionId,
    type ConnectionIdImportResolver,
    type ConnectionIdResolutionContext,
    type ResolvedObjectExpression,
    type SameModuleConnectionIdBindings,
} from './connection-id-values';
import type { ModuleImport, ParsedModuleRecord } from './module-graph';
import { walkModuleGraph } from './walk-module-graph';

interface ModuleConnectionIdAnalysis {
    bindings: SameModuleConnectionIdBindings;
    record: ParsedModuleRecord;
    scopeAnalysis: ScopeAnalysis;
}

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
    const analyses = new Map<string, ModuleConnectionIdAnalysis>();

    const getAnalysis = (moduleId: string): ModuleConnectionIdAnalysis => {
        const existing = analyses.get(moduleId);
        if (existing) {
            return existing;
        }

        const record = modules.get(moduleId);
        if (!record) {
            throw unsupportedConnectionId(
                entryId,
                `module ${moduleId} is outside the module graph`,
            );
        }

        const imports = collectActionCatalogImports(record.ast);
        const scopeAnalysis = analyzeActionCatalogScopes(record.ast, imports);
        const bindings = collectSameModuleConnectionIdBindings(record.ast, scopeAnalysis);
        const analysis = { bindings, record, scopeAnalysis };
        analyses.set(moduleId, analysis);
        return analysis;
    };

    const hasExport = (
        moduleId: string,
        exportName: string,
        visited = new Set<string>(),
    ): boolean => {
        const key = `${moduleId}:${exportName}`;
        if (visited.has(key)) {
            return false;
        }
        visited.add(key);

        const record = modules.get(moduleId);
        if (!record) {
            return false;
        }
        if (record.exports.some((moduleExport) => moduleExport.exportedName === exportName)) {
            return true;
        }
        if (record.reExports.some((reExport) => reExport.exportedName === exportName)) {
            return true;
        }
        return record.starExports.some(
            (starExport) =>
                starExport.resolvedId && hasExport(starExport.resolvedId, exportName, visited),
        );
    };

    const getImportedBinding = (moduleId: string, localName: string): ModuleImport => {
        const { record } = getAnalysis(moduleId);
        const importedBinding = record.imports.find((binding) => binding.localName === localName);
        if (!importedBinding) {
            throw unsupportedConnectionId(moduleId, `missing import binding for ${localName}`);
        }
        if (!importedBinding.resolvedId || !modules.has(importedBinding.resolvedId)) {
            throw unsupportedConnectionId(
                moduleId,
                `imported value ${localName} outside the module graph`,
            );
        }
        if (importedBinding.kind === 'default') {
            throw unsupportedConnectionId(
                moduleId,
                `default imported connectionId binding ${localName}`,
            );
        }
        if (importedBinding.kind === 'namespace') {
            throw unsupportedConnectionId(
                moduleId,
                `namespace imported connectionId binding ${localName}`,
            );
        }
        return importedBinding;
    };

    const findLocalBinding = (analysis: ModuleConnectionIdAnalysis, localName: string) => {
        for (const variable of analysis.bindings.byVariable.keys()) {
            if (variable.name === localName) {
                return variable;
            }
        }
        return undefined;
    };

    const resolveExportedValue = (
        moduleId: string,
        exportName: string,
        context: ConnectionIdResolutionContext,
        visited = new Set<string>(),
    ): string => {
        const key = `${moduleId}:${exportName}:value`;
        if (visited.has(key)) {
            throw unsupportedConnectionId(
                moduleId,
                `cyclic imported connectionId export ${exportName}`,
            );
        }
        visited.add(key);

        const analysis = getAnalysis(moduleId);
        const localExport = analysis.record.exports.find(
            (moduleExport) => moduleExport.exportedName === exportName,
        );
        if (localExport) {
            const importRelay = analysis.record.imports.find(
                (binding) => binding.localName === localExport.localName,
            );
            if (importRelay) {
                return resolveImportedValue(importRelay, context, visited);
            }

            const variable = findLocalBinding(analysis, localExport.localName);
            if (!variable) {
                throw unsupportedConnectionId(
                    moduleId,
                    `non-top-level exported connectionId binding ${localExport.localName}`,
                );
            }
            const binding = analysis.bindings.byVariable.get(variable);
            if (!binding) {
                throw unsupportedConnectionId(
                    moduleId,
                    `non-top-level exported connectionId binding ${localExport.localName}`,
                );
            }
            if (binding.kind === 'mutable') {
                throw unsupportedConnectionId(
                    moduleId,
                    `mutable ${binding.declarationKind} exported connectionId binding ${localExport.localName}`,
                );
            }
            if (binding.kind === 'unsupported-pattern') {
                throw unsupportedConnectionId(
                    moduleId,
                    `destructured exported connectionId binding ${localExport.localName}`,
                );
            }
            if (!binding.init) {
                throw unsupportedConnectionId(
                    moduleId,
                    `uninitialized exported const connectionId binding ${localExport.localName}`,
                );
            }
            return resolveConnectionIdValue(
                binding.init,
                createResolutionContext(analysis, context.importResolver, context.seen),
            );
        }

        const reExport = analysis.record.reExports.find(
            (candidate) => candidate.exportedName === exportName,
        );
        if (reExport) {
            if (!reExport.resolvedId || !modules.has(reExport.resolvedId)) {
                throw unsupportedConnectionId(
                    moduleId,
                    `re-export ${exportName} outside the module graph`,
                );
            }
            return resolveExportedValue(
                reExport.resolvedId,
                reExport.importedName,
                context,
                visited,
            );
        }

        const matchingStarExports = analysis.record.starExports.filter(
            (starExport) => starExport.resolvedId && hasExport(starExport.resolvedId, exportName),
        );
        if (matchingStarExports.length > 1) {
            throw unsupportedConnectionId(
                moduleId,
                `ambiguous export * connectionId ${exportName}`,
            );
        }
        const [matchingStarExport] = matchingStarExports;
        if (matchingStarExport?.resolvedId) {
            return resolveExportedValue(
                matchingStarExport.resolvedId,
                exportName,
                context,
                visited,
            );
        }

        throw unsupportedConnectionId(moduleId, `missing export ${exportName}`);
    };

    const resolveExportedObject = (
        moduleId: string,
        exportName: string,
        context: ConnectionIdResolutionContext,
        visited = new Set<string>(),
    ): ResolvedObjectExpression => {
        const key = `${moduleId}:${exportName}:object`;
        if (visited.has(key)) {
            throw unsupportedConnectionId(
                moduleId,
                `cyclic imported connectionId object export ${exportName}`,
            );
        }
        visited.add(key);

        const analysis = getAnalysis(moduleId);
        const localExport = analysis.record.exports.find(
            (moduleExport) => moduleExport.exportedName === exportName,
        );
        if (localExport) {
            const importRelay = analysis.record.imports.find(
                (binding) => binding.localName === localExport.localName,
            );
            if (importRelay) {
                return resolveImportedObject(importRelay, context, visited);
            }

            const variable = findLocalBinding(analysis, localExport.localName);
            const binding = variable ? analysis.bindings.byVariable.get(variable) : undefined;
            if (!binding) {
                throw unsupportedConnectionId(
                    moduleId,
                    `non-top-level exported connectionId object binding ${localExport.localName}`,
                );
            }
            if (binding.kind === 'mutable') {
                throw unsupportedConnectionId(
                    moduleId,
                    `mutable ${binding.declarationKind} exported connectionId object binding ${localExport.localName}`,
                );
            }
            if (binding.kind === 'unsupported-pattern') {
                throw unsupportedConnectionId(
                    moduleId,
                    `destructured exported connectionId object binding ${localExport.localName}`,
                );
            }
            if (!binding.init) {
                throw unsupportedConnectionId(
                    moduleId,
                    `uninitialized exported const connectionId object binding ${localExport.localName}`,
                );
            }
            return resolveObjectExpressionValue(
                binding.init,
                createResolutionContext(analysis, context.importResolver, context.seen),
            );
        }

        const reExport = analysis.record.reExports.find(
            (candidate) => candidate.exportedName === exportName,
        );
        if (reExport) {
            if (!reExport.resolvedId || !modules.has(reExport.resolvedId)) {
                throw unsupportedConnectionId(
                    moduleId,
                    `re-export ${exportName} outside the module graph`,
                );
            }
            return resolveExportedObject(
                reExport.resolvedId,
                reExport.importedName,
                context,
                visited,
            );
        }

        const matchingStarExports = analysis.record.starExports.filter(
            (starExport) => starExport.resolvedId && hasExport(starExport.resolvedId, exportName),
        );
        if (matchingStarExports.length > 1) {
            throw unsupportedConnectionId(
                moduleId,
                `ambiguous export * connectionId object ${exportName}`,
            );
        }
        const [matchingStarExport] = matchingStarExports;
        if (matchingStarExport?.resolvedId) {
            return resolveExportedObject(
                matchingStarExport.resolvedId,
                exportName,
                context,
                visited,
            );
        }

        throw unsupportedConnectionId(moduleId, `missing export ${exportName}`);
    };

    const resolveImportedValue = (
        importedBinding: ModuleImport,
        context: ConnectionIdResolutionContext,
        visited?: Set<string>,
    ): string => {
        if (!importedBinding.resolvedId) {
            throw unsupportedConnectionId(
                context.filePath,
                `imported value ${importedBinding.localName} outside the module graph`,
            );
        }
        return resolveExportedValue(
            importedBinding.resolvedId,
            importedBinding.importedName,
            context,
            visited,
        );
    };

    const resolveImportedObject = (
        importedBinding: ModuleImport,
        context: ConnectionIdResolutionContext,
        visited?: Set<string>,
    ): ResolvedObjectExpression => {
        if (!importedBinding.resolvedId) {
            throw unsupportedConnectionId(
                context.filePath,
                `imported value ${importedBinding.localName} outside the module graph`,
            );
        }
        return resolveExportedObject(
            importedBinding.resolvedId,
            importedBinding.importedName,
            context,
            visited,
        );
    };

    const importResolver: ConnectionIdImportResolver = {
        resolveImportedIdentifier(identifier, context) {
            const importedBinding = getImportedBinding(context.filePath, identifier.name);
            return resolveImportedValue(importedBinding, context);
        },
        resolveImportedObject(identifier, context) {
            const importedBinding = getImportedBinding(context.filePath, identifier.name);
            return resolveImportedObject(importedBinding, context);
        },
    };

    walkModuleGraph(entryId, modules, buildRoot, ({ moduleId, record }) => {
        const analysis = getAnalysis(moduleId);

        for (const callSite of findActionCatalogCallSites(
            record.ast,
            analysis.scopeAnalysis,
            moduleId,
        )) {
            const connectionId = extractConnectionIdFromActionCall(
                callSite,
                analysis.bindings,
                analysis.scopeAnalysis,
                moduleId,
                importResolver,
            );
            if (!connectionId) {
                continue;
            }
            connectionIds.add(connectionId);
        }
    });

    return [...connectionIds].sort();
}

function createResolutionContext(
    analysis: ModuleConnectionIdAnalysis,
    importResolver: ConnectionIdImportResolver | undefined,
    seen: Set<eslintScope.Variable>,
): ConnectionIdResolutionContext {
    return {
        bindings: analysis.bindings,
        filePath: analysis.record.id,
        importResolver,
        scopeAnalysis: analysis.scopeAnalysis,
        seen,
    };
}
