// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode } from 'estree';
import type { ModuleInfo } from 'rollup';
import type { Plugin } from 'vite';

import {
    createParsedModuleRecord,
    type ParsedModuleRecord,
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

                const record = createParsedModuleRecord(
                    moduleId,
                    buildRoot,
                    moduleInfo.ast as BaseNode,
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
