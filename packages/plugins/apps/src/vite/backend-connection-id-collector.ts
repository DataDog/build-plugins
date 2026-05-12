// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode } from 'estree';
import type { ModuleInfo } from 'rollup';
import type { Plugin } from 'vite';

import {
    createParsedModuleRecord,
    extractConnectionIdsFromParsedModuleGraph,
    normalizeModuleId,
    type ParsedModuleRecord,
    shouldCollectBackendModule,
} from '../backend/ast-parsing/module-graph-connection-ids';

export interface BackendConnectionIdCollector {
    plugin: Plugin;
    getAllowedConnectionIds: () => string[];
}

export function createBackendConnectionIdCollector(
    entryId: string,
    buildRoot: string,
): BackendConnectionIdCollector {
    const records = new Map<string, ParsedModuleRecord>();

    return {
        plugin: {
            name: 'dd-backend-connection-id-collector',
            moduleParsed(moduleInfo: ModuleInfo) {
                const moduleId = normalizeModuleId(moduleInfo.id);
                if (!shouldCollectBackendModule(moduleId, buildRoot)) {
                    return;
                }

                records.set(
                    moduleId,
                    createParsedModuleRecord(moduleId, moduleInfo.ast as BaseNode, [
                        ...moduleInfo.importedIds,
                    ]),
                );
            },
        },
        getAllowedConnectionIds() {
            return extractConnectionIdsFromParsedModuleGraph(entryId, records, buildRoot);
        },
    };
}
