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
} from '../backend/ast-parsing/module-graph';
import { analyzeModuleScope } from '../backend/ast-parsing/module-scope';
import { runBackendStaticChecks } from '../backend/ast-parsing/run-backend-static-checks';
import { ensureProgram } from '../backend/ast-parsing/type-guards';

import { isViteVirtualModuleId, normalizeViteModuleId } from './backend-module-graph-collector';

// Distinct from module-graph.ts's `unsupportedModuleGraphDependency` — that message is specific to connection-ID collection, unrelated to this plugin's fallback parse.
function unsupportedStaticChecksSource(filePath: string, unsupported: string): Error {
    return new Error(
        `Unsupported module source for ${filePath}: ${unsupported} could hide a Node-builtin import or restricted-global access.`,
    );
}

// Re-runs the static checks against every app-local module the nested backend build resolves, not just the `.backend.ts` entry, so an imported helper module is also checked. MUST be registered after the connection-ID collector's plugin so `getModuleRecords` is populated (falls back to a local parse if a module is missing from it).
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
                    throw unsupportedStaticChecksSource(
                        moduleId,
                        `unparseable module source (${reason})`,
                    );
                }
                // Shared so the checks below don't each independently re-walk this fallback-parsed AST to build the same scope graph.
                const program = ensureProgram(ast, moduleId);
                scopeAnalysis = analyzeModuleScope(program);
            }

            runBackendStaticChecks(ast, moduleId, log, scopeAnalysis);
        },
    };
}
