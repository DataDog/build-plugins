// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { ModuleInfo } from 'rollup';
import type { Plugin } from 'vite';

import {
    createParsedModuleRecord,
    type ParsedModuleRecord,
    shouldTraverseCollectedModule,
} from '../backend/ast-parsing/module-graph';

const VIRTUAL_MODULE_ID_RE = /^(?:\0|virtual:)/;

export interface BackendModuleGraphCollector {
    plugin: Plugin;
    getModuleRecords: () => ReadonlyMap<string, ParsedModuleRecord>;
}

export function createBackendModuleGraphCollector(buildRoot: string): BackendModuleGraphCollector {
    const records = new Map<string, ParsedModuleRecord>();

    return {
        plugin: {
            name: 'dd-backend-module-graph-collector',
            moduleParsed(moduleInfo: ModuleInfo) {
                const moduleId = normalizeViteModuleId(moduleInfo.id);
                if (isViteVirtualModuleId(moduleId)) {
                    return;
                }

                // `createParsedModuleRecord` applies this same predicate, but
                // only after the AST exists. Checking it here keeps us from
                // parsing every `node_modules` module just to discard it.
                if (!shouldTraverseCollectedModule(moduleId, buildRoot)) {
                    return;
                }

                // Parse the source instead of reading `moduleInfo.ast`: Rolldown,
                // the bundler Vite 8 uses by default, stubs that getter to throw
                // `UNSUPPORTED: ModuleInfo#ast`. `code` is null for external and
                // synthetic modules.
                //
                // `this.parse` is the bundler's own parser, which already parsed
                // this exact source to compute `importedIds` — so whatever the
                // bundler accepted parses here too, and no TypeScript-capable
                // parser is needed (`moduleParsed` runs after `transform`, so
                // types and JSX are already gone).
                if (typeof moduleInfo.code !== 'string') {
                    return;
                }

                const parsed = this.parse(moduleInfo.code);
                const record = createParsedModuleRecord(
                    moduleId,
                    buildRoot,
                    parsed,
                    getStaticDependencyIds(moduleInfo).map(normalizeViteModuleId),
                );
                if (!record) {
                    return;
                }

                records.set(record.id, record);
            },
        },
        getModuleRecords() {
            return records;
        },
    };
}

function normalizeViteModuleId(id: string): string {
    return id.split('?')[0];
}

function getStaticDependencyIds(moduleInfo: ModuleInfo): string[] {
    return moduleInfo.importedIdResolutions?.map(({ id }) => id) ?? [...moduleInfo.importedIds];
}

function isViteVirtualModuleId(id: string): boolean {
    return VIRTUAL_MODULE_ID_RE.test(id);
}
