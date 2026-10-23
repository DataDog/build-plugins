// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import type { Plugin, Rollup } from 'vite';

import {
    ACTION_FQN_PREFIX,
    collectActionCatalogExportFqns,
} from '../backend/ast-parsing/action-catalog-fqns';
import type { ParsedModuleRecord } from '../backend/ast-parsing/module-graph';
import { ensureProgram } from '../backend/ast-parsing/type-guards';

import { isViteVirtualModuleId, normalizeViteModuleId } from './backend-module-graph-collector';

export interface ActionCatalogFqnCollector {
    plugin: Plugin;
    getExportFqnsByModule: () => ReadonlyMap<string, ReadonlyMap<string, string>>;
}

// Register after the connection-ID collector's plugin, whose records it reuses instead of re-parsing.
export function createActionCatalogFqnCollector(
    log: Logger,
    getModuleRecords: () => ReadonlyMap<string, ParsedModuleRecord>,
): ActionCatalogFqnCollector {
    const exportFqnsByModule = new Map<string, Map<string, string>>();

    return {
        plugin: {
            name: 'dd-action-catalog-fqn-collector',
            moduleParsed(moduleInfo: Rollup.ModuleInfo) {
                const moduleId = normalizeViteModuleId(moduleInfo.id);
                if (
                    isViteVirtualModuleId(moduleId) ||
                    typeof moduleInfo.code !== 'string' ||
                    !moduleInfo.code.includes(ACTION_FQN_PREFIX)
                ) {
                    return;
                }
                try {
                    let program = getModuleRecords().get(moduleId)?.ast;
                    if (!program) {
                        const ast = this.parse(moduleInfo.code);
                        program = ensureProgram(ast, moduleId);
                    }
                    const exportFqns = collectActionCatalogExportFqns(program);
                    exportFqnsByModule.set(moduleId, exportFqns);
                } catch (error) {
                    // A module without a table only drops the action list, never fails the build.
                    const reason = error instanceof Error ? error.message : String(error);
                    log.debug(`Skipped the action FQNs of ${moduleId}: ${reason}`);
                }
            },
        },
        getExportFqnsByModule() {
            return exportFqnsByModule;
        },
    };
}
