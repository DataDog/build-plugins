// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { ModuleInfo } from 'rollup';
import type { Plugin } from 'vite';

import {
    createParsedModuleRecord,
    type ParsedModuleRecord,
    shouldTraverseCollectedModule,
    unsupportedModuleGraphDependency,
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

                // External and synthetic modules have no source to parse.
                if (typeof moduleInfo.code !== 'string') {
                    return;
                }

                // Parse the source instead of reading `moduleInfo.ast`: Rolldown,
                // the bundler Vite 8 uses by default, stubs that getter to throw
                // `UNSUPPORTED: ModuleInfo#ast`.
                //
                // No TypeScript-capable parser is needed because `moduleParsed`
                // runs after `transform`, so types and JSX are already compiled
                // away. Note that `this.parse` is the bundler's parser but not
                // its parser *configuration* — Rollup binds no options to it,
                // while its own module parse passes `{ jsx }`. Our nested build
                // never enables `jsx`, so the two agree today; fail closed rather
                // than silently if they ever diverge, since a module we cannot
                // parse may hide a connection ID.
                let parsed;
                try {
                    parsed = this.parse(moduleInfo.code);
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    throw unsupportedModuleGraphDependency(
                        moduleId,
                        `unparseable module source (${reason})`,
                    );
                }

                const record = createParsedModuleRecord(
                    moduleId,
                    buildRoot,
                    parsed,
                    getStaticDependencyIds(moduleInfo).map(normalizeViteModuleId),
                );
                // Only null when the traversal predicate rejects, which the guard
                // above already covered; kept to narrow the nullable return type.
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
