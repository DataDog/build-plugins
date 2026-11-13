// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Plugin } from 'vite';

import type { ExtractedConnections } from '../backend/ast-parsing/extract-connection-ids-from-module-graph';
import { extractConnectionsFromModuleGraph } from '../backend/ast-parsing/extract-connection-ids-from-module-graph';
import type { ParsedModuleRecord } from '../backend/ast-parsing/module-graph';

import { createBackendModuleGraphCollector } from './backend-module-graph-collector';

export interface BackendConnectionIdCollector {
    plugin: Plugin;
    getConnections: () => ExtractedConnections;
    /** Exposed so a plugin sharing this build (e.g. the static-checks plugin) can reuse these records instead of re-parsing every module. */
    getModuleRecords: () => ReadonlyMap<string, ParsedModuleRecord>;
}

export function createBackendConnectionIdCollector(
    entryId: string,
    buildRoot: string,
): BackendConnectionIdCollector {
    const moduleGraphCollector = createBackendModuleGraphCollector(buildRoot);

    return {
        plugin: moduleGraphCollector.plugin,
        getConnections() {
            const moduleRecords = moduleGraphCollector.getModuleRecords();
            return extractConnectionsFromModuleGraph(entryId, moduleRecords, buildRoot);
        },
        getModuleRecords: moduleGraphCollector.getModuleRecords,
    };
}
