// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import type { BaseNode } from 'estree';
import type { ModuleInfo } from 'rollup';
import type { Plugin } from 'vite';

import {
    type ParsedModuleRecord,
    shouldTraverseCollectedModule,
    unsupportedModuleGraphDependency,
} from '../backend/ast-parsing/module-graph';
import { analyzeModuleScope } from '../backend/ast-parsing/module-scope';
import { rejectNodeBuiltinImports } from '../backend/ast-parsing/reject-node-builtin-imports';
import { rejectRestrictedGlobals } from '../backend/ast-parsing/reject-restricted-globals';
import { ensureProgram } from '../backend/ast-parsing/type-guards';
import { warnAboutDivergentGlobals } from '../backend/ast-parsing/warn-divergent-globals';

import { isViteVirtualModuleId, normalizeViteModuleId } from './backend-module-graph-collector';

// Re-runs the static checks against every app-local module the nested backend build resolves (not just the `.backend.ts` entry), since a helper module imported by the entry is otherwise never checked; MUST be registered after the connection-ID collector's plugin so `getModuleRecords` is already populated (falls back to parsing locally if a module is missing from it).
export function createBackendStaticChecksPlugin(
    buildRoot: string,
    log: Logger,
    getModuleRecords: () => ReadonlyMap<string, ParsedModuleRecord>,
): Plugin {
    return {
        name: 'dd-backend-static-checks',
        moduleParsed(moduleInfo: ModuleInfo) {
            const moduleId = normalizeViteModuleId(moduleInfo.id);
            if (
                isViteVirtualModuleId(moduleId) ||
                !shouldTraverseCollectedModule(moduleId, buildRoot)
            ) {
                return;
            }

            const existingRecord = getModuleRecords().get(moduleId);
            let ast: BaseNode;
            let scopeAnalysis: ReturnType<typeof analyzeModuleScope>;

            if (existingRecord) {
                ast = existingRecord.ast;
                scopeAnalysis = existingRecord.scopeAnalysis;
            } else {
                if (typeof moduleInfo.code !== 'string') {
                    return;
                }
                try {
                    ast = this.parse(moduleInfo.code);
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    throw unsupportedModuleGraphDependency(
                        moduleId,
                        `unparseable module source (${reason})`,
                    );
                }
                // Shared so rejectRestrictedGlobals/warnAboutDivergentGlobals don't each independently re-walk this fallback-parsed AST to build the same scope graph.
                scopeAnalysis = analyzeModuleScope(ensureProgram(ast, moduleId));
            }

            rejectNodeBuiltinImports(ast, moduleId);
            rejectRestrictedGlobals(ast, moduleId, scopeAnalysis);
            warnAboutDivergentGlobals(ast, moduleId, log, scopeAnalysis);
        },
    };
}
